import {
  AppServerRequestError,
  type AgentMessageDelta,
  type AppServerClient,
} from "./app-server-client.js";
import type { CodexDeltaMetadata, CodexRuntime } from "../gateway/gateway-service.js";
import { randomUUID } from "node:crypto";

export class AppServerCodexRuntime implements CodexRuntime {
  readonly #client: AppServerClient;
  readonly #permissions: {
    sandbox: "workspace-write" | "danger-full-access";
    approvalPolicy: "on-request" | "never";
  };

  constructor(
    client: AppServerClient,
    permissions: {
      sandbox: "workspace-write" | "danger-full-access";
      approvalPolicy: "on-request" | "never";
    } = { sandbox: "workspace-write", approvalPolicy: "on-request" },
  ) {
    this.#client = client;
    this.#permissions = permissions;
  }

  startSession(input: { workspacePath: string; readOnly?: boolean }): Promise<string> {
    return this.#client.startThread({
      cwd: input.workspacePath,
      sandbox: input.readOnly ? "read-only" : this.#permissions.sandbox,
      approvalPolicy: this.#permissions.approvalPolicy,
      ephemeral: false,
    });
  }

  forkSession(input: { threadId: string; workspacePath: string; readOnly?: boolean }): Promise<string> {
    return this.#client.forkThread({
      threadId: input.threadId,
      cwd: input.workspacePath,
      sandbox: input.readOnly ? "read-only" : this.#permissions.sandbox,
      approvalPolicy: this.#permissions.approvalPolicy,
      ephemeral: false,
    });
  }

  async resumeSession(input: { threadId: string; workspacePath: string; readOnly?: boolean }): Promise<string> {
    try {
      return await this.#client.resumeThread({
        threadId: input.threadId,
        cwd: input.workspacePath,
        sandbox: input.readOnly ? "read-only" : this.#permissions.sandbox,
        approvalPolicy: this.#permissions.approvalPolicy,
      });
    } catch (error) {
      if (isMissingThreadError(error)) {
        return this.startSession({
          workspacePath: input.workspacePath,
          ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
        });
      }
      throw error;
    }
  }

  async archiveSession(threadId: string): Promise<void> {
    try {
      await this.#client.archiveThread(threadId);
    } catch (error) {
      if (!isMissingThreadError(error)) throw error;
    }
  }

  async listSessions(input: { workspacePath: string; archived?: boolean }) {
    const sessions = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const result = await this.#client.listThreads({
        cwd: input.workspacePath,
        limit: 100,
        archived: input.archived ?? false,
        ...(cursor ? { cursor } : {}),
      });
      sessions.push(...result.threads);
      if (!result.nextCursor) return sessions;
      if (seenCursors.has(result.nextCursor)) {
        throw new Error("thread/list returned a repeated pagination cursor");
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("thread/list exceeded the pagination safety limit");
  }

  async runTurn(input: {
    threadId: string;
    text: string;
    localImages?: string[];
    onTurnStarted: (turnId: string) => void;
    onDelta: (delta: string, metadata?: CodexDeltaMetadata) => void;
  }): Promise<{ turnId: string; status: string }> {
    let turnId: string | undefined;
    const earlyDeltas: AgentMessageDelta[] = [];
    const onDelta = (event: AgentMessageDelta) => {
      if (event.threadId !== input.threadId) return;
      if (!turnId) {
        earlyDeltas.push(event);
      } else if (event.turnId === turnId) {
        input.onDelta(event.delta, {
          ...(event.itemId ? { itemId: event.itemId } : {}),
          phase: event.phase ?? null,
        });
      }
    };
    this.#client.on("agentMessageDelta", onDelta);
    try {
      turnId = await this.#client.startTurn(input.threadId, {
        text: input.text,
        ...(input.localImages ? { localImages: input.localImages } : {}),
      });
      input.onTurnStarted(turnId);
      for (const event of earlyDeltas) {
        if (event.turnId === turnId) {
          input.onDelta(event.delta, {
            ...(event.itemId ? { itemId: event.itemId } : {}),
            phase: event.phase ?? null,
          });
        }
      }
      const completed = await this.#client.waitForTurn(turnId);
      return { turnId, status: completed.status };
    } finally {
      this.#client.off("agentMessageDelta", onDelta);
    }
  }

  interrupt(threadId: string, turnId: string): Promise<void> {
    return this.#client.interruptTurn(threadId, turnId);
  }
}

function isMissingThreadError(error: unknown): boolean {
  if (!(error instanceof AppServerRequestError)) return false;
  if (error.serverMessage.startsWith("no rollout found for thread id ")) return true;
  return error.code === -32600 && error.serverMessage.startsWith("thread not loaded:");
}

export class UnavailableCodexRuntime implements CodexRuntime {
  async startSession(_input: { workspacePath: string; readOnly?: boolean }): Promise<string> {
    return `unavailable:${randomUUID()}`;
  }

  async forkSession(_input: { threadId: string; workspacePath: string; readOnly?: boolean }): Promise<string> {
    return `unavailable:${randomUUID()}`;
  }

  async resumeSession(input: { threadId: string }): Promise<string> {
    return input.threadId;
  }

  async archiveSession(): Promise<void> {
    throw new Error("Codex app-server 当前不可用，无法归档 Session");
  }

  async listSessions(): Promise<[]> {
    return [];
  }

  async runTurn(input: {
    threadId: string;
    text: string;
    localImages?: string[];
    onTurnStarted: (turnId: string) => void;
    onDelta: (delta: string, metadata?: CodexDeltaMetadata) => void;
  }): Promise<{ turnId: string; status: string }> {
    const turnId = `unavailable:${randomUUID()}`;
    input.onTurnStarted(turnId);
    input.onDelta(
      "Codex app-server 当前不可用。网关处于安全降级模式，本次任务未执行，也不会伪造流式输出或远程审批。",
    );
    return { turnId, status: "failed" };
  }

  async interrupt(): Promise<void> {
    // No Codex turn exists in safe degraded mode.
  }
}

export class SwitchableCodexRuntime implements CodexRuntime {
  #delegate: CodexRuntime;
  #status: string;

  constructor(delegate: CodexRuntime, status: string) {
    this.#delegate = delegate;
    this.#status = status;
  }

  get status(): string {
    return this.#status;
  }

  setDelegate(delegate: CodexRuntime, status: string): void {
    this.#delegate = delegate;
    this.#status = status;
  }

  startSession(input: { workspacePath: string; readOnly?: boolean }): Promise<string> {
    return this.#delegate.startSession(input);
  }

  forkSession(input: { threadId: string; workspacePath: string; readOnly?: boolean }): Promise<string> {
    return this.#delegate.forkSession(input);
  }

  resumeSession(input: { threadId: string; workspacePath: string; readOnly?: boolean }): Promise<string> {
    return this.#delegate.resumeSession(input);
  }

  archiveSession(threadId: string): Promise<void> {
    return this.#delegate.archiveSession(threadId);
  }

  listSessions(input: { workspacePath: string; archived?: boolean }) {
    return this.#delegate.listSessions(input);
  }

  runTurn(input: {
    threadId: string;
    text: string;
    localImages?: string[];
    onTurnStarted: (turnId: string) => void;
    onDelta: (delta: string, metadata?: CodexDeltaMetadata) => void;
  }): Promise<{ turnId: string; status: string }> {
    return this.#delegate.runTurn(input);
  }

  interrupt(threadId: string, turnId: string): Promise<void> {
    return this.#delegate.interrupt(threadId, turnId);
  }
}
