import { randomUUID } from "node:crypto";

import type { ProjectQueue } from "../queue/project-queue.js";
import type { StateStore } from "../state/state-store.js";
import { CardStreamWriter } from "./card-stream-writer.js";
import {
  ExecutionHostUnavailableError,
  type ExecutionHostDirectory,
} from "../codex/host-routing-runtime.js";

class RemoteAttachmentUnsupportedError extends Error {
  constructor() {
    super("附件暂不支持发送到远端 worker；请切换到网关主机执行，或先发送纯文字任务。");
    this.name = "RemoteAttachmentUnsupportedError";
  }
}

export interface InboundMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group" | "topic";
  senderId: string;
  text: string;
  attachments?: InboundAttachment[];
  receivedAt: number;
  rootMessageId?: string;
}

export interface InboundAttachment {
  kind: "image" | "file";
  fileKey: string;
  displayName?: string;
}

export interface DownloadedAttachment {
  path: string;
  cleanup(): Promise<void>;
}

export interface FeishuPort {
  addReaction(messageId: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  createAnswerCard(chatId: string): Promise<string>;
  updateAnswerCard(cardId: string, content: string, sequence: number): Promise<void>;
  finishAnswerCard(cardId: string, content: string, sequence: number, status: string): Promise<void>;
  sendRichFallback(chatId: string, title: string, content: string): Promise<void>;
  downloadAttachment(messageId: string, attachment: InboundAttachment): Promise<DownloadedAttachment>;
}

export interface CodexDeltaMetadata {
  itemId?: string;
  phase?: "commentary" | "final_answer" | null;
}

export interface CodexRuntime {
  startSession(input: { workspacePath: string; readOnly?: boolean }): Promise<string>;
  forkSession(input: { threadId: string; workspacePath: string; readOnly?: boolean }): Promise<string>;
  resumeSession(input: { threadId: string; workspacePath: string; readOnly?: boolean }): Promise<string>;
  archiveSession(threadId: string): Promise<void>;
  listSessions(input: { workspacePath: string; archived?: boolean }): Promise<Array<{
    threadId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
  }>>;
  runTurn(input: {
    threadId: string;
    text: string;
    localImages?: string[];
    onTurnStarted: (turnId: string) => void;
    onDelta: (delta: string, metadata?: CodexDeltaMetadata) => void;
  }): Promise<{ turnId: string; status: string }>;
  interrupt(threadId: string, turnId: string): Promise<void>;
}

export type HandleResult = {
  kind: "rejected" | "duplicate" | "completed" | "failed" | "cancelled";
  runId?: string;
};

interface GatewayOptions {
  store: StateStore;
  queue: ProjectQueue;
  feishu: FeishuPort;
  codex: CodexRuntime;
  executionHosts?: ExecutionHostDirectory;
  approvals?: { cancelRun(runId: string): Promise<void> };
  projectId: string;
  projectDisplayName: string;
  workspacePath: string;
  allowedSenderId: string;
  streamIntervalMs?: number;
  now?: () => number;
  id?: () => string;
  onError?: (error: Error) => void;
}

export class GatewayService {
  readonly #store: StateStore;
  readonly #queue: ProjectQueue;
  readonly #feishu: FeishuPort;
  readonly #codex: CodexRuntime;
  readonly #executionHosts: ExecutionHostDirectory | undefined;
  readonly #approvals: { cancelRun(runId: string): Promise<void> } | undefined;
  readonly #projectId: string;
  readonly #projectDisplayName: string;
  readonly #workspacePath: string;
  readonly #allowedSenderId: string;
  readonly #streamIntervalMs: number;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #onError: (error: Error) => void;

  constructor(options: GatewayOptions) {
    this.#store = options.store;
    this.#queue = options.queue;
    this.#feishu = options.feishu;
    this.#codex = options.codex;
    this.#executionHosts = options.executionHosts;
    this.#approvals = options.approvals;
    this.#projectId = options.projectId;
    this.#projectDisplayName = options.projectDisplayName;
    this.#workspacePath = options.workspacePath;
    this.#allowedSenderId = options.allowedSenderId;
    this.#streamIntervalMs = options.streamIntervalMs ?? 250;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#onError = options.onError ?? (() => {});
  }

  async handleMessage(message: InboundMessage): Promise<HandleResult> {
    if (
      message.chatType !== "p2p" ||
      message.senderId !== this.#allowedSenderId ||
      (!message.text.trim() && !message.attachments?.length)
    ) {
      return { kind: "rejected" };
    }

    const claim = this.#store.claimInboundEvent({
      eventId: message.eventId,
      messageId: message.messageId,
      chatId: message.chatId,
      senderId: message.senderId,
      receivedAt: message.receivedAt,
    });
    if (!claim.claimed) {
      return claim.runId ? { kind: "duplicate", runId: claim.runId } : { kind: "duplicate" };
    }

    const scopeKey = message.rootMessageId
      ? `${message.chatId}:${message.rootMessageId}`
      : message.chatId;
    const session = await this.#ensureSession(scopeKey);
    const runId = this.#id();
    this.#store.createRun({
      runId,
      eventId: message.eventId,
      sessionId: session.sessionId,
      now: this.#now(),
    });

    return this.#queue.run(this.#projectId, async () =>
      this.#executeRun(runId, session.sessionId, session.codexThreadId, session.mode, message),
    );
  }

  async #ensureSession(scopeKey: string): Promise<{
    sessionId: string;
    codexThreadId: string;
    mode: "write" | "read_only";
  }> {
    const activeSessionId = this.#store.getActiveSessionId(scopeKey);
    if (activeSessionId) {
      const active = this.#store.getSession(activeSessionId);
      if (active && active.status === "ACTIVE") {
        return { sessionId: active.sessionId, codexThreadId: active.codexThreadId, mode: active.mode };
      }
    }

    const codexThreadId = await this.#codex.startSession({ workspacePath: this.#workspacePath });
    const sessionId = this.#id();
    const now = this.#now();
    this.#store.createSession({
      sessionId,
      codexThreadId,
      projectId: this.#projectId,
      title: `${this.#projectDisplayName} · 默认任务`,
      now,
    });
    this.#store.bindScope(scopeKey, sessionId, now);
    return { sessionId, codexThreadId, mode: "write" };
  }

  async #executeRun(
    runId: string,
    sessionId: string,
    initialThreadId: string,
    mode: "write" | "read_only",
    message: InboundMessage,
  ): Promise<HandleResult> {
    let threadId = initialThreadId;
    let reactionId: string | undefined;
    let stream: CardStreamWriter | undefined;
    const downloaded: DownloadedAttachment[] = [];
    try {
      reactionId = await this.#feishu.addReaction(message.messageId);
      this.#store.recordReaction({
        messageId: message.messageId,
        reactionId,
        runId,
        now: this.#now(),
      });

      const cardId = await this.#feishu.createAnswerCard(message.chatId);
      this.#store.attachCard(runId, cardId, this.#now());
      this.#store.transitionRun(runId, "RUNNING", this.#now());
      stream = new CardStreamWriter(this.#feishu, cardId, this.#streamIntervalMs, {
        chatId: message.chatId,
        onCardCreated: (continuationCardId) =>
          this.#store.attachRunCard(runId, continuationCardId, this.#now()),
        onCardEvent: (event) => this.#store.recordRunCardEvent({
          runId,
          ...event,
          now: this.#now(),
        }),
      });

      if (
        message.attachments?.length &&
        this.#executionHosts &&
        this.#executionHosts.hostIdForThread(threadId) !== this.#executionHosts.defaultHostId
      ) {
        throw new RemoteAttachmentUnsupportedError();
      }

      for (const attachment of message.attachments ?? []) {
        downloaded.push(await this.#feishu.downloadAttachment(message.messageId, attachment));
      }
      const localImages = downloaded
        .filter((_, index) => message.attachments?.[index]?.kind === "image")
        .map((attachment) => attachment.path);
      const fileLines = downloaded
        .map((attachment, index) => ({ attachment, source: message.attachments?.[index] }))
        .filter(({ source }) => source?.kind === "file")
        .map(({ attachment, source }) =>
          `- ${source?.displayName ?? "飞书文件"}：${attachment.path}`,
        );
      const prompt = [
        message.text.trim() || defaultAttachmentPrompt(message.attachments ?? []),
        ...(fileLines.length > 0
          ? [
              "以下路径由网关从当前飞书消息安全下载，仅用于本次任务；请读取文件内容，不要移动或持久化临时文件：",
              ...fileLines,
            ]
          : []),
      ].join("\n\n");

      const resumedThreadId = await this.#codex.resumeSession({
        threadId,
        workspacePath: this.#workspacePath,
        readOnly: mode === "read_only",
      });
      if (resumedThreadId !== threadId) {
        this.#store.replaceSessionThread(sessionId, resumedThreadId, this.#now());
        threadId = resumedThreadId;
      }

      const turn = await this.#codex.runTurn({
        threadId,
        text: prompt,
        ...(localImages.length > 0 ? { localImages } : {}),
        onTurnStarted: (turnId) => this.#store.attachTurn(runId, turnId, this.#now()),
        onDelta: createCardDeltaHandler(stream),
      });

      const state = turn.status === "completed" ? "COMPLETED" : turn.status === "interrupted" ? "CANCELLED" : "FAILED";
      await stream.finish(state.toLowerCase());
      this.#store.transitionRun(runId, state, this.#now(), state === "FAILED" ? "codex_turn_failed" : null);
      try {
        await this.#executionHosts?.refreshThread?.(threadId);
      } catch {
        // Desktop presentation is best effort and must not change the durable Codex run result.
      }
      return { kind: state === "COMPLETED" ? "completed" : state === "CANCELLED" ? "cancelled" : "failed", runId };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.#onError(normalizedError);
      try {
        await this.#approvals?.cancelRun(runId);
      } catch {
        // Run failure must still be persisted even if approval cancellation cleanup fails.
      }
      const current = this.#store.getRun(runId);
      if (current && !["COMPLETED", "FAILED", "CANCELLED"].includes(current.state)) {
        this.#store.transitionRun(runId, "FAILED", this.#now(), "gateway_run_failed");
      }
      let failureReportedInCard = false;
      if (stream) {
        try {
          if (normalizedError instanceof ExecutionHostUnavailableError) {
            stream.append(
              `${stream.content ? "\n\n" : ""}${normalizedError.hostDisplayName} 当前离线，本次任务未执行。` +
                "本次任务未在网关主机自动执行；请在“当前状态”中明确切换执行主机后重试。",
            );
          } else if (normalizedError instanceof RemoteAttachmentUnsupportedError) {
            stream.append(normalizedError.message);
          } else if (!stream.content) {
            stream.append("任务执行失败，请稍后重试。");
          }
          await stream.finish("failed");
          failureReportedInCard = true;
        } catch {
          // CardKit failure is recorded by run state; plain text fallback belongs in the concrete adapter.
        }
      }
      if (!failureReportedInCard) {
        try {
          await this.#feishu.sendRichFallback(
            message.chatId,
            "Codex · 卡片降级",
            stream?.content || "任务执行失败，请稍后重试。",
          );
        } catch {
          // Rich post is the last in-product fallback; keep the durable FAILED state for diagnosis.
        }
      }
      return { kind: "failed", runId };
    } finally {
      for (const attachment of downloaded.reverse()) {
        try {
          await attachment.cleanup();
        } catch {
          // Attachment cleanup is best effort; startup cleanup handles stale directories.
        }
      }
      const currentReaction = this.#store.getUnclearedReactionForRun(runId);
      if (currentReaction) {
        try {
          await this.#feishu.removeReaction(currentReaction.messageId, currentReaction.reactionId);
          this.#store.clearReaction(currentReaction.messageId, this.#now());
        } catch {
          // Startup stale-reaction cleanup will retry.
        }
      }
    }
  }
}

function createCardDeltaHandler(stream: CardStreamWriter): (
  delta: string,
  metadata?: CodexDeltaMetadata,
) => void {
  let finalAnswerStarted = false;
  let activeItemId: string | undefined;
  return (delta, metadata) => {
    if (!delta) return;
    if (metadata?.phase === "commentary" && finalAnswerStarted) return;
    if (metadata?.phase === "final_answer" && !finalAnswerStarted) {
      finalAnswerStarted = true;
      activeItemId = undefined;
      stream.replace("");
    }
    const startsNewItem = Boolean(
      metadata?.itemId &&
      activeItemId &&
      metadata.itemId !== activeItemId &&
      stream.content,
    );
    stream.append(`${startsNewItem ? "\n\n" : ""}${delta}`);
    if (metadata?.itemId) activeItemId = metadata.itemId;
  };
}

function defaultAttachmentPrompt(attachments: InboundAttachment[]): string {
  if (attachments.some((attachment) => attachment.kind === "file")) {
    return "请读取并概括我发送的文件；如果内容中有明确任务，请按内容处理。";
  }
  return "请查看并说明我发送的图片。";
}
