import type { CodexDeltaMetadata, CodexRuntime } from "../gateway/gateway-service.js";

const THREAD_SEPARATOR = "::";

export function encodeExecutionThreadId(hostId: string, rawThreadId: string): string {
  const prefix = `${hostId}${THREAD_SEPARATOR}`;
  return rawThreadId.startsWith(prefix) ? rawThreadId : `${prefix}${rawThreadId}`;
}

export interface ExecutionHostStatus {
  available: boolean;
  detail: string;
}

export interface ExecutionHostSummary extends ExecutionHostStatus {
  hostId: string;
  displayName: string;
  workspacePath: string;
}

export interface ExecutionHostDirectory {
  readonly defaultHostId: string;
  listHosts(): ExecutionHostSummary[];
  hostIdForThread(threadId: string): string;
  workspacePathForHost(hostId: string): string;
  refreshThread?(threadId: string): Promise<void>;
}

export interface HostDefinition {
  hostId: string;
  displayName: string;
  workspacePath: string;
  runtime: CodexRuntime;
  status(): ExecutionHostStatus;
  refreshThread?: (threadId: string) => Promise<void>;
}

export class ExecutionHostUnavailableError extends Error {
  readonly hostId: string;
  readonly hostDisplayName: string;
  readonly detail: string;

  constructor(hostId: string, hostDisplayName: string, detail: string) {
    super(`${hostDisplayName} 当前不可用：${detail}`);
    this.name = "ExecutionHostUnavailableError";
    this.hostId = hostId;
    this.hostDisplayName = hostDisplayName;
    this.detail = detail;
  }
}

export class HostRoutingCodexRuntime implements CodexRuntime, ExecutionHostDirectory {
  readonly defaultHostId: string;
  readonly #hosts = new Map<string, HostDefinition>();
  readonly #onRefreshError: (input: { hostId: string; threadId: string; error: Error }) => void;

  constructor(input: {
    defaultHostId: string;
    hosts: HostDefinition[];
    onRefreshError?: (input: { hostId: string; threadId: string; error: Error }) => void;
  }) {
    if (input.hosts.length === 0) throw new Error("at least one execution host is required");
    for (const host of input.hosts) {
      if (!host.hostId || host.hostId.includes(THREAD_SEPARATOR)) {
        throw new Error(`invalid execution host id: ${host.hostId}`);
      }
      if (this.#hosts.has(host.hostId)) throw new Error(`duplicate execution host: ${host.hostId}`);
      this.#hosts.set(host.hostId, host);
    }
    if (!this.#hosts.has(input.defaultHostId)) throw new Error("default execution host is not configured");
    this.defaultHostId = input.defaultHostId;
    this.#onRefreshError = input.onRefreshError ?? (() => {});
  }

  listHosts(): ExecutionHostSummary[] {
    return [...this.#hosts.values()].map((host) => ({
      hostId: host.hostId,
      displayName: host.displayName,
      workspacePath: host.workspacePath,
      ...host.status(),
    }));
  }

  hostIdForThread(threadId: string): string {
    const separator = threadId.indexOf(THREAD_SEPARATOR);
    if (separator <= 0) return this.defaultHostId;
    const hostId = threadId.slice(0, separator);
    return this.#hosts.has(hostId) ? hostId : this.defaultHostId;
  }

  workspacePathForHost(hostId: string): string {
    return this.#host(hostId).workspacePath;
  }

  async refreshThread(threadId: string): Promise<void> {
    const { host, rawThreadId } = this.#resolveThread(threadId);
    if (!host.refreshThread) return;
    try {
      await host.refreshThread(rawThreadId);
    } catch (error) {
      this.#onRefreshError({
        hostId: host.hostId,
        threadId: rawThreadId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async startSession(input: { workspacePath: string; readOnly?: boolean }): Promise<string> {
    const host = this.#hostForWorkspace(input.workspacePath);
    this.#assertAvailable(host);
    const threadId = await host.runtime.startSession({
      workspacePath: host.workspacePath,
      ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
    });
    return this.#encode(host.hostId, threadId);
  }

  async forkSession(input: { threadId: string; workspacePath: string; readOnly?: boolean }): Promise<string> {
    const { host, rawThreadId } = this.#resolveThread(input.threadId);
    this.#assertAvailable(host);
    const threadId = await host.runtime.forkSession({
      threadId: rawThreadId,
      workspacePath: host.workspacePath,
      ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
    });
    return this.#encode(host.hostId, threadId);
  }

  async resumeSession(input: { threadId: string; workspacePath: string; readOnly?: boolean }): Promise<string> {
    const { host, rawThreadId } = this.#resolveThread(input.threadId);
    this.#assertAvailable(host);
    const threadId = await host.runtime.resumeSession({
      threadId: rawThreadId,
      workspacePath: host.workspacePath,
      ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
    });
    return this.#encode(host.hostId, threadId);
  }

  async listSessions(input: { workspacePath: string; archived?: boolean }) {
    const host = this.#hostForWorkspace(input.workspacePath);
    this.#assertAvailable(host);
    const sessions = await host.runtime.listSessions({
      workspacePath: host.workspacePath,
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
    });
    return sessions.map((session) => ({
      ...session,
      threadId: this.#encode(host.hostId, session.threadId),
    }));
  }

  async runTurn(input: {
    threadId: string;
    text: string;
    localImages?: string[];
    onTurnStarted: (turnId: string) => void;
    onDelta: (delta: string, metadata?: CodexDeltaMetadata) => void;
  }): Promise<{ turnId: string; status: string }> {
    const { host, rawThreadId } = this.#resolveThread(input.threadId);
    this.#assertAvailable(host);
    return await host.runtime.runTurn({
      ...input,
      threadId: rawThreadId,
    });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    const { host, rawThreadId } = this.#resolveThread(threadId);
    this.#assertAvailable(host);
    await host.runtime.interrupt(rawThreadId, turnId);
  }

  #host(hostId: string): HostDefinition {
    const host = this.#hosts.get(hostId);
    if (!host) throw new Error(`unknown execution host: ${hostId}`);
    return host;
  }

  #hostForWorkspace(workspacePath: string): HostDefinition {
    const host = [...this.#hosts.values()].find((candidate) => candidate.workspacePath === workspacePath);
    if (!host) throw new Error(`no execution host owns workspace: ${workspacePath}`);
    return host;
  }

  #resolveThread(threadId: string): { host: HostDefinition; rawThreadId: string } {
    const hostId = this.hostIdForThread(threadId);
    const prefix = `${hostId}${THREAD_SEPARATOR}`;
    return {
      host: this.#host(hostId),
      rawThreadId: threadId.startsWith(prefix) ? threadId.slice(prefix.length) : threadId,
    };
  }

  #encode(hostId: string, rawThreadId: string): string {
    return encodeExecutionThreadId(hostId, rawThreadId);
  }

  #assertAvailable(host: HostDefinition): void {
    const status = host.status();
    if (!status.available) {
      throw new ExecutionHostUnavailableError(host.hostId, host.displayName, status.detail);
    }
  }
}
