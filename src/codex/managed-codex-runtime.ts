import type { CodexDeltaMetadata, CodexRuntime } from "../gateway/gateway-service.js";
import { UnavailableCodexRuntime } from "./codex-runtime.js";

export interface ManagedCodexConnection {
  runtime: CodexRuntime;
  close(): Promise<void>;
  onExit(listener: (event: { code: number | null; signal: NodeJS.Signals | null }) => void): void;
}

interface Options {
  displayName: string;
  connect(): Promise<ManagedCodexConnection>;
  reconnectDelayMs?: number;
  onError?: (error: Error) => void;
}

export class ManagedCodexRuntime implements CodexRuntime {
  readonly #displayName: string;
  readonly #connect: () => Promise<ManagedCodexConnection>;
  readonly #reconnectDelayMs: number;
  readonly #onError: (error: Error) => void;
  #delegate: CodexRuntime = new UnavailableCodexRuntime();
  #connection: ManagedCodexConnection | null = null;
  #connecting: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #available = false;
  #detail = "尚未连接";

  constructor(options: Options) {
    this.#displayName = options.displayName;
    this.#connect = options.connect;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 15_000;
    this.#onError = options.onError ?? (() => {});
  }

  get available(): boolean { return this.#available; }
  get detail(): string { return this.#detail; }

  async start(): Promise<void> {
    this.#stopped = false;
    await this.#attemptConnect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const connection = this.#connection;
    this.#connection = null;
    this.#available = false;
    this.#detail = "已停止";
    this.#delegate = new UnavailableCodexRuntime();
    await connection?.close().catch((error: unknown) => this.#onError(normalizeError(error)));
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

  async #attemptConnect(): Promise<void> {
    if (this.#stopped || this.#connecting || this.#available) return this.#connecting ?? Promise.resolve();
    this.#connecting = (async () => {
      try {
        const connection = await this.#connect();
        if (this.#stopped) {
          await connection.close();
          return;
        }
        this.#connection = connection;
        this.#delegate = connection.runtime;
        this.#available = true;
        this.#detail = "已连接";
        connection.onExit(() => this.#handleExit());
      } catch (error) {
        const normalized = normalizeError(error);
        this.#available = false;
        this.#detail = `连接失败：${normalized.message}`;
        this.#delegate = new UnavailableCodexRuntime();
        this.#onError(normalized);
        this.#scheduleReconnect();
      } finally {
        this.#connecting = null;
      }
    })();
    await this.#connecting;
  }

  #handleExit(): void {
    if (this.#stopped) return;
    this.#connection = null;
    this.#available = false;
    this.#detail = "连接已断开，等待重连";
    this.#delegate = new UnavailableCodexRuntime();
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#attemptConnect();
    }, this.#reconnectDelayMs);
    this.#timer.unref();
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
