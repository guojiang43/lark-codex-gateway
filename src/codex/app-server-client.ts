import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Duplex } from "node:stream";
import WebSocket from "ws";

export type ApprovalDecision = "accept" | "decline" | "cancel";

export interface ApprovalRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

interface AppServerClientOptions {
  command: string;
  args?: string[];
  transport?: "stdio" | "websocket";
  websocketUrl?: string;
  approvalTimeoutMs?: number;
  decideApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface TurnCompleted {
  id: string;
  status: string;
}

interface TurnWaiter {
  resolve: (turn: TurnCompleted) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export interface AgentMessageDelta {
  threadId: string;
  turnId: string;
  itemId?: string;
  delta: string;
  phase?: MessagePhase | null;
}

export type MessagePhase = "commentary" | "final_answer";

export interface TurnInput {
  text: string;
  localImages?: string[];
}

export interface AppServerThreadSummary {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export class AppServerRequestError extends Error {
  readonly method: string;
  readonly code: number | undefined;
  readonly serverMessage: string;

  constructor(method: string, payload: unknown) {
    const value = isRecord(payload) ? payload : {};
    const code = typeof value.code === "number" ? value.code : undefined;
    const serverMessage = typeof value.message === "string" ? value.message : "unknown app-server error";
    super(`app-server request failed (${method}): ${serverMessage}`);
    this.name = "AppServerRequestError";
    this.method = method;
    this.code = code;
    this.serverMessage = serverMessage;
  }
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export class AppServerClient extends EventEmitter {
  readonly #process: ChildProcessWithoutNullStreams | null;
  readonly #socket: WebSocket | null;
  readonly #ready: Promise<void>;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #turnWaiters = new Map<string, TurnWaiter>();
  readonly #completedTurns = new Map<string, TurnCompleted>();
  readonly #agentMessagePhases = new Map<string, MessagePhase>();
  readonly #approvalTimeoutMs: number;
  readonly #decideApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  #nextId = 1;
  #closed = false;
  #exitEmitted = false;

  constructor(options: AppServerClientOptions) {
    super();
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    this.#decideApproval = options.decideApproval ?? (async () => "decline");
    if (options.transport === "websocket") {
      const proxy = options.websocketUrl ? null : this.#spawn(options.command, options.args ?? []);
      this.#process = proxy;
      const connection = proxy ? commandProxyStream(proxy) : undefined;
      const socket = new WebSocket(options.websocketUrl ?? "ws://codex-app-server/rpc", {
        perMessageDeflate: false,
        ...(connection ? { createConnection: () => connection } : {}),
      });
      this.#socket = socket;
      this.#ready = new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.on("message", (data) => this.#consumeLine(String(data)));
      socket.on("error", (error) => this.#failAll(error));
      socket.once("close", () => {
        if (!this.#closed) this.#transportExited(null, null, new Error("app-server WebSocket closed"));
      });
    } else {
      const child = this.#spawn(options.command, options.args ?? ["app-server", "--stdio"]);
      this.#process = child;
      this.#socket = null;
      this.#ready = Promise.resolve();
      const stdout = createInterface({ input: child.stdout });
      stdout.on("line", (line) => this.#consumeLine(line));
    }
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "lark-codex-gateway",
        title: "Lark Codex Gateway",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
  }

  async startThread(input: {
    cwd: string;
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy: "untrusted" | "on-request" | "never";
    ephemeral?: boolean;
  }): Promise<string> {
    const result = (await this.request("thread/start", input)) as { thread: { id: string } };
    return result.thread.id;
  }

  async resumeThread(input: {
    threadId: string;
    cwd?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy?: "untrusted" | "on-request" | "never";
    excludeTurns?: boolean;
  }): Promise<string> {
    const result = (await this.request("thread/resume", input)) as { thread: { id: string } };
    return result.thread.id;
  }

  async listThreads(input: {
    cwd: string;
    limit?: number;
    archived?: boolean;
    cursor?: string;
  }): Promise<{ threads: AppServerThreadSummary[]; nextCursor: string | null }> {
    const result = (await this.request("thread/list", {
      cwd: input.cwd,
      archived: input.archived ?? false,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit ?? 100,
      sortKey: "updated_at",
      sortDirection: "desc",
    })) as {
      data?: Array<{
        id?: unknown;
        name?: unknown;
        preview?: unknown;
        createdAt?: unknown;
        updatedAt?: unknown;
      }>;
      nextCursor?: unknown;
    };
    const threads = (result.data ?? []).flatMap((row): AppServerThreadSummary[] => {
      if (typeof row.id !== "string") return [];
      const title = displayTitle(row.name, row.preview, row.id);
      return [{
        threadId: row.id,
        title,
        createdAt: normalizeTimestamp(row.createdAt),
        updatedAt: normalizeTimestamp(row.updatedAt),
      }];
    });
    return {
      threads,
      nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
    };
  }

  async forkThread(input: {
    threadId: string;
    cwd: string;
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy: "untrusted" | "on-request" | "never";
    ephemeral?: boolean;
  }): Promise<string> {
    const result = (await this.request("thread/fork", {
      threadId: input.threadId,
      cwd: input.cwd,
      sandbox: input.sandbox,
      approvalPolicy: input.approvalPolicy,
      ephemeral: input.ephemeral ?? false,
      excludeTurns: true,
    })) as { thread: { id: string } };
    return result.thread.id;
  }

  async startTurn(threadId: string, input: string | TurnInput): Promise<string> {
    const normalized = typeof input === "string" ? { text: input } : input;
    const result = (await this.request("turn/start", {
      threadId,
      input: [
        { type: "text", text: normalized.text },
        ...(normalized.localImages ?? []).map((path) => ({ type: "localImage", path })),
      ],
    })) as { turn: { id: string } };
    return result.turn.id;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  waitForTurn(turnId: string, timeoutMs?: number): Promise<TurnCompleted> {
    const completed = this.#completedTurns.get(turnId);
    if (completed) {
      return Promise.resolve(completed);
    }
    return new Promise<TurnCompleted>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.#turnWaiters.delete(turnId);
        reject(new Error(`timeout waiting for turn ${turnId}`));
      }, timeoutMs);
      this.#turnWaiters.set(turnId, { resolve, reject, timer });
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      throw new Error("app-server client is closed");
    }
    await this.#ready;
    if (this.#closed) throw new Error("app-server client is closed");
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    void this.#ready.then(() => this.#write({ jsonrpc: "2.0", method, params })).catch((error: unknown) => {
      this.#failAll(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error("app-server client is closed"));
    const socket = this.#socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }
    const child = this.#process;
    if (!child) return;
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #consumeLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit("protocolError", new Error("app-server emitted invalid JSON"));
      return;
    }

    if (message.method && message.id !== undefined && APPROVAL_METHODS.has(message.method)) {
      void this.#handleApproval(message as Required<Pick<JsonRpcMessage, "id" | "method">> & JsonRpcMessage);
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
      if (pending) {
        this.#pending.delete(message.id as number);
        if (message.error !== undefined) {
          pending.reject(new AppServerRequestError(pending.method, message.error));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (message.method === "item/started") {
      this.#rememberAgentMessagePhase(message.params ?? {});
    } else if (message.method === "item/agentMessage/delta") {
      const event = message.params as unknown as AgentMessageDelta;
      const phase = event.itemId
        ? this.#agentMessagePhases.get(agentMessageKey(event.threadId, event.turnId, event.itemId)) ?? null
        : null;
      this.emit("agentMessageDelta", { ...event, phase });
    } else if (message.method === "turn/completed") {
      const turn = (message.params?.turn ?? {}) as TurnCompleted;
      if (turn.id) {
        this.#completedTurns.set(turn.id, turn);
        const waiter = this.#turnWaiters.get(turn.id);
        if (waiter) {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.#turnWaiters.delete(turn.id);
          waiter.resolve(turn);
        }
      }
    }
    if (message.method) {
      this.emit("notification", message.method, message.params ?? {});
    }
  }

  #rememberAgentMessagePhase(params: Record<string, unknown>): void {
    const item = isRecord(params.item) ? params.item : {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
    const itemId = typeof item.id === "string" ? item.id : undefined;
    const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
    if (item.type !== "agentMessage" || !threadId || !turnId || !itemId || !phase) return;
    this.#agentMessagePhases.set(agentMessageKey(threadId, turnId, itemId), phase);
  }

  async #handleApproval(message: Required<Pick<JsonRpcMessage, "id" | "method">> & JsonRpcMessage): Promise<void> {
    const request: ApprovalRequest = {
      id: message.id,
      method: message.method,
      params: message.params ?? {},
    };
    this.emit("approvalRequested", request);
    let timer: NodeJS.Timeout | undefined;
    try {
      const decision = await Promise.race([
        this.#decideApproval(request),
        new Promise<ApprovalDecision>((resolve) => {
          timer = setTimeout(() => resolve("decline"), this.#approvalTimeoutMs);
        }),
      ]);
      this.#write({ jsonrpc: "2.0", id: message.id, result: { decision } });
    } catch {
      this.#write({ jsonrpc: "2.0", id: message.id, result: { decision: "decline" } });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #write(message: unknown): void {
    if (this.#closed) throw new Error("app-server client is closed");
    if (this.#socket) {
      this.#socket.send(JSON.stringify(message));
      return;
    }
    this.#process?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #spawn(command: string, args: string[]): ChildProcessWithoutNullStreams {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => this.emit("stderr", line));
    child.once("error", (error) => this.#failAll(error));
    child.once("exit", (code, signal) => {
      if (!this.#closed) {
        this.#transportExited(
          code,
          signal,
          new Error(`codex app-server exited (code=${String(code)}, signal=${String(signal)})`),
        );
      }
    });
    return child;
  }

  #transportExited(code: number | null, signal: NodeJS.Signals | null, error: Error): void {
    if (this.#exitEmitted) return;
    this.#exitEmitted = true;
    this.emit("exit", { code, signal });
    this.#failAll(error);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const waiter of this.#turnWaiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#turnWaiters.clear();
  }
}

function commandProxyStream(child: ChildProcessWithoutNullStreams): Duplex {
  const stream = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      if (child.stdin.write(chunk, encoding)) callback();
      else child.stdin.once("drain", callback);
    },
    final(callback) {
      child.stdin.end(callback);
    },
  });
  child.stdout.on("data", (chunk) => stream.push(chunk));
  child.stdout.once("end", () => stream.push(null));
  child.stdout.once("error", (error) => stream.destroy(error));
  Object.assign(stream, {
    setKeepAlive: () => stream,
    setNoDelay: () => stream,
    setTimeout: () => stream,
  });
  queueMicrotask(() => stream.emit("connect"));
  return stream;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function agentMessageKey(threadId: string, turnId: string, itemId: string): string {
  return `${threadId}\u0000${turnId}\u0000${itemId}`;
}

function displayTitle(name: unknown, preview: unknown, threadId: string): string {
  const candidate = [name, preview]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const normalized = candidate?.replace(/\s+/g, " ").trim() ?? `Codex Session · ${threadId.slice(0, 8)}`;
  return normalized.length > 60 ? `${normalized.slice(0, 57)}…` : normalized;
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return Date.now();
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}
