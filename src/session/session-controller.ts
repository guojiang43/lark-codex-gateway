import { randomUUID } from "node:crypto";

import type { CodexRuntime } from "../gateway/gateway-service.js";
import type { ProjectQueue } from "../queue/project-queue.js";
import type { StateStore } from "../state/state-store.js";
import type { ExecutionHostDirectory } from "../codex/host-routing-runtime.js";
import {
  currentSessionCard,
  healthCard,
  helpCard,
  operationResultCard,
  renameSessionCard,
  sessionPickerCard,
} from "./session-cards.js";

export interface SessionFeishuPort {
  sendCard(chatId: string, card: Record<string, unknown>): Promise<{ cardId: string; messageId: string }>;
}

export interface ApprovalCancellationPort {
  cancelRun(runId: string): Promise<void>;
}

export interface MenuEvent {
  eventId: string;
  operatorId: string;
  eventKey: string;
  receivedAt?: number;
}

export interface CardActionEvent {
  eventId: string;
  messageId: string;
  chatId: string;
  operatorId: string;
  actionValue: Record<string, unknown>;
  formValue?: Record<string, unknown>;
  receivedAt?: number;
}

export interface CallbackResponse {
  toast: { type: "info" | "success" | "warning" | "error"; content: string };
}

interface Options {
  store: StateStore;
  feishu: SessionFeishuPort;
  codex: CodexRuntime;
  queue: ProjectQueue;
  approvals?: ApprovalCancellationPort;
  projectId: string;
  projectDisplayName: string;
  workspacePath: string;
  allowedSenderId: string;
  now?: () => number;
  id?: () => string;
  onError?: (error: Error) => void;
  codexStatus?: string | (() => string);
  executionHosts?: ExecutionHostDirectory;
}

export class SessionController {
  readonly #store: StateStore;
  readonly #feishu: SessionFeishuPort;
  readonly #codex: CodexRuntime;
  readonly #queue: ProjectQueue;
  readonly #approvals: ApprovalCancellationPort | undefined;
  readonly #projectId: string;
  readonly #projectDisplayName: string;
  readonly #workspacePath: string;
  readonly #allowedSenderId: string;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #onError: (error: Error) => void;
  readonly #startedAt: number;
  readonly #codexStatus: () => string;
  readonly #executionHosts: ExecutionHostDirectory | undefined;
  readonly #pending = new Set<Promise<void>>();

  constructor(options: Options) {
    this.#store = options.store;
    this.#feishu = options.feishu;
    this.#codex = options.codex;
    this.#queue = options.queue;
    this.#approvals = options.approvals;
    this.#projectId = options.projectId;
    this.#projectDisplayName = options.projectDisplayName;
    this.#workspacePath = options.workspacePath;
    this.#allowedSenderId = options.allowedSenderId;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#onError = options.onError ?? (() => {});
    this.#startedAt = this.#now();
    const codexStatus = options.codexStatus;
    this.#codexStatus = typeof codexStatus === "function"
      ? codexStatus
      : () => codexStatus ?? "已初始化";
    this.#executionHosts = options.executionHosts;
  }

  handleMenu(event: MenuEvent): CallbackResponse {
    if (event.operatorId !== this.#allowedSenderId) return errorToast("没有操作权限");
    if (!this.#claim(event.eventId, "menu", event.operatorId, event.receivedAt)) {
      return infoToast("该操作已处理");
    }
    const chatId = this.#store.getLatestChatForSender(event.operatorId);
    if (!chatId) return errorToast("请先在机器人单聊发送一条消息建立会话");
    this.#schedule(
      chatId,
      () => this.#dispatchMenu(chatId, event.eventKey),
      event.eventKey === "stop_generation" || event.eventKey === "current_status",
    );
    return infoToast("正在处理");
  }

  handleCardAction(event: CardActionEvent): CallbackResponse {
    if (event.operatorId !== this.#allowedSenderId) return errorToast("没有操作权限");
    if (!this.#claim(event.eventId, "card", event.operatorId, event.receivedAt)) {
      return infoToast("该操作已处理");
    }
    const action = event.actionValue.action;
    if (typeof action !== "string" || !KNOWN_ACTIONS.has(action)) {
      return { toast: { type: "warning", content: "不支持的操作" } };
    }
    this.#schedule(event.chatId, () => this.#dispatchAction(event, action), action === "run.stop");
    return infoToast("正在处理");
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#pending]);
  }

  #claim(eventId: string, eventKind: "menu" | "card", operatorId: string, receivedAt?: number): boolean {
    return this.#store.claimInteractionEvent({
      eventId,
      eventKind,
      operatorId,
      receivedAt: receivedAt ?? this.#now(),
    });
  }

  #schedule(chatId: string, work: () => Promise<void>, bypassQueue = false): void {
    const execution = bypassQueue ? work() : this.#queue.run(this.#projectId, work);
    const pending = execution.catch(async (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.#onError(normalized);
      try {
        await this.#feishu.sendCard(chatId, operationResultCard("操作失败", "本次操作未完成，请稍后重试。", false));
      } catch {
        // The caller already received a callback toast; avoid an unhandled rejection.
      }
    });
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending));
  }

  async #dispatchMenu(chatId: string, eventKey: string): Promise<void> {
    switch (eventKey) {
      case "new_session":
        await this.#createAndActivate(chatId, false);
        break;
      case "fork_session":
        await this.#forkAndActivate(chatId);
        break;
      case "new_readonly":
        await this.#createAndActivate(chatId, true);
        break;
      case "session_select":
        await this.#sendPicker(chatId);
        break;
      case "session_current":
        await this.#sendCurrent(chatId);
        break;
      case "current_status":
        await this.#sendHealth(chatId);
        break;
      case "session_rename":
        await this.#sendRenamePrompt(chatId);
        break;
      case "session_archive":
        await this.#sendCurrent(chatId);
        break;
      case "stop_generation":
        await this.#stop(chatId);
        break;
      case "help":
      default:
        await this.#feishu.sendCard(chatId, helpCard());
    }
  }

  async #dispatchAction(event: CardActionEvent, action: string): Promise<void> {
    switch (action) {
      case "session.new":
        await this.#createAndActivate(event.chatId, false);
        break;
      case "session.readonly":
        await this.#createAndActivate(event.chatId, true);
        break;
      case "session.fork":
        await this.#forkAndActivate(event.chatId);
        break;
      case "session.select":
        await this.#sendPicker(event.chatId, pageValue(event.actionValue.page));
        break;
      case "session.switch":
        await this.#switch(event.chatId, stringValue(event.actionValue.session_id, "session_id"));
        break;
      case "session.rename.prompt":
        await this.#sendRenamePrompt(event.chatId, stringValue(event.actionValue.session_id, "session_id"));
        break;
      case "session.rename":
        await this.#rename(
          event.chatId,
          stringValue(event.actionValue.session_id, "session_id"),
          stringValue(event.formValue?.title, "title"),
        );
        break;
      case "session.archive":
        await this.#archive(event.chatId, stringValue(event.actionValue.session_id, "session_id"));
        break;
      case "run.stop":
        await this.#stop(event.chatId);
        break;
      case "execution_host.switch":
        await this.#switchExecutionHost(
          event.chatId,
          stringValue(event.actionValue.target_host_id, "target_host_id"),
        );
        break;
    }
  }

  async #createAndActivate(chatId: string, readOnly: boolean): Promise<void> {
    const hostId = this.#currentHostId(chatId);
    await this.#createAndActivateOnHost(chatId, readOnly, hostId);
  }

  async #createAndActivateOnHost(chatId: string, readOnly: boolean, hostId: string): Promise<void> {
    const workspacePath = this.#workspacePathForHost(hostId);
    const threadId = await this.#codex.startSession({ workspacePath, readOnly });
    const sessionId = this.#id();
    const now = this.#now();
    this.#store.createSession({
      sessionId,
      codexThreadId: threadId,
      projectId: this.#projectId,
      title: readOnly ? "只读分析" : "新会话",
      mode: readOnly ? "read_only" : "write",
      now,
    });
    this.#store.bindScope(chatId, sessionId, now);
    await this.#sendCurrent(chatId);
  }

  async #forkAndActivate(chatId: string): Promise<void> {
    const active = this.#activeSession(chatId);
    const hostId = this.#hostIdForThread(active.codexThreadId);
    const threadId = await this.#codex.forkSession({
      threadId: active.codexThreadId,
      workspacePath: this.#workspacePathForHost(hostId),
      readOnly: active.mode === "read_only",
    });
    const sessionId = this.#id();
    const now = this.#now();
    this.#store.createSession({
      sessionId,
      codexThreadId: threadId,
      projectId: this.#projectId,
      title: `${active.title} · 分叉`,
      mode: active.mode,
      now,
    });
    this.#store.bindScope(chatId, sessionId, now);
    await this.#sendCurrent(chatId);
  }

  async #switch(chatId: string, sessionId: string): Promise<void> {
    const session = this.#store.getSession(sessionId);
    if (!session || session.projectId !== this.#projectId || session.status !== "ACTIVE") {
      throw new Error("session is unavailable");
    }
    this.#store.bindScope(chatId, sessionId, this.#now());
    await this.#sendCurrent(chatId);
  }

  async #rename(chatId: string, sessionId: string, title: string): Promise<void> {
    const session = this.#store.getSession(sessionId);
    if (!session || session.projectId !== this.#projectId || session.status !== "ACTIVE") {
      throw new Error("session is unavailable");
    }
    this.#store.renameSession(sessionId, title, this.#now());
    await this.#sendCurrent(chatId);
  }

  async #archive(chatId: string, sessionId: string): Promise<void> {
    const session = this.#store.getSession(sessionId);
    if (!session || session.projectId !== this.#projectId || session.status !== "ACTIVE") {
      throw new Error("session is unavailable");
    }
    this.#store.archiveSession(sessionId, this.#now());
    if (this.#store.getActiveSessionId(chatId) === sessionId) {
      const replacement = this.#store.listSessions(this.#projectId, { limit: 1 })[0];
      if (replacement) {
        this.#store.bindScope(chatId, replacement.sessionId, this.#now());
      } else {
        await this.#createAndActivate(chatId, false);
        return;
      }
    }
    await this.#sendPicker(chatId);
  }

  async #stop(chatId: string): Promise<void> {
    const run = this.#store.getLatestActiveRunForChat(chatId);
    if (!run) {
      await this.#feishu.sendCard(chatId, operationResultCard("当前状态", "没有正在运行的任务。"));
      return;
    }
    await this.#approvals?.cancelRun(run.runId);
    await this.#codex.interrupt(run.codexThreadId, run.turnId);
    await this.#feishu.sendCard(chatId, operationResultCard("已发送停止请求", "当前 turn 正在收口。"));
  }

  async #sendPicker(chatId: string, page = 0): Promise<void> {
    const hostId = this.#currentHostId(chatId);
    await this.#syncHostSessions(hostId);
    const pageSize = 8;
    const allRows = this.#store.listSessions(this.#projectId, { limit: 100 })
      .filter((session) => this.#hostIdForThread(session.codexThreadId) === hostId);
    const rows = allRows.slice(page * pageSize, (page + 1) * pageSize + 1);
    await this.#feishu.sendCard(
      chatId,
      sessionPickerCard({
        projectName: this.#projectDisplayName,
        sessions: rows.slice(0, pageSize),
        activeSessionId: this.#store.getActiveSessionId(chatId),
        page,
        hasNext: rows.length > pageSize,
        ...(this.#executionHosts
          ? { executionHostName: this.#hostSummary(hostId).displayName }
          : {}),
      }),
    );
  }

  async #syncHostSessions(hostId = this.#executionHosts?.defaultHostId): Promise<void> {
    try {
      const workspacePath = hostId ? this.#workspacePathForHost(hostId) : this.#workspacePath;
      const discovered = await this.#codex.listSessions({ workspacePath });
      for (const thread of discovered) {
        this.#store.ensureDiscoveredSession({
          sessionId: this.#id(),
          codexThreadId: thread.threadId,
          projectId: this.#projectId,
          title: thread.title,
          now: thread.updatedAt || thread.createdAt || this.#now(),
        });
      }
    } catch (error) {
      this.#onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #sendCurrent(chatId: string): Promise<void> {
    const session = this.#activeSession(chatId);
    const hostId = this.#hostIdForThread(session.codexThreadId);
    await this.#feishu.sendCard(
      chatId,
      currentSessionCard({
        projectName: this.#projectDisplayName,
        session,
        activeRun: this.#store.getLatestActiveRunForChat(chatId),
        ...(this.#executionHosts
          ? { executionHostName: this.#hostSummary(hostId).displayName }
          : {}),
      }),
    );
  }

  async #sendHealth(chatId: string): Promise<void> {
    const currentHostId = this.#currentHostId(chatId);
    await this.#feishu.sendCard(chatId, healthCard({
      projectName: this.#projectDisplayName,
      queueBusy: this.#queue.isBusy(this.#projectId),
      sessionCount: this.#store.listSessions(this.#projectId, { limit: 100 }).length,
      uptimeMs: this.#now() - this.#startedAt,
      codexStatus: this.#codexStatus(),
      ...(this.#executionHosts
        ? {
            gatewayHostName: "M4",
            currentExecutionHostId: currentHostId,
            executionHosts: this.#executionHosts.listHosts(),
          }
        : {}),
    }));
  }

  async #switchExecutionHost(chatId: string, targetHostId: string): Promise<void> {
    if (!this.#executionHosts) throw new Error("execution host routing is unavailable");
    const target = this.#executionHosts.listHosts().find((host) => host.hostId === targetHostId);
    if (!target) throw new Error("unknown execution host");
    if (!target.available) {
      await this.#feishu.sendCard(
        chatId,
        operationResultCard(
          `${target.displayName} 当前离线`,
          `执行主机未切换，仍保留当前 Session。状态：${target.detail}`,
          false,
        ),
      );
      return;
    }
    if (this.#store.getLatestActiveRunForChat(chatId)) {
      await this.#feishu.sendCard(
        chatId,
        operationResultCard("暂时不能切换", "当前任务仍在运行，请先等待完成或停止生成。", false),
      );
      return;
    }
    if (targetHostId === this.#currentHostId(chatId)) {
      await this.#sendCurrent(chatId);
      return;
    }
    await this.#syncHostSessions(targetHostId);
    const targetSession = this.#store.listSessions(this.#projectId, { limit: 100 })
      .find((session) => this.#hostIdForThread(session.codexThreadId) === targetHostId);
    if (targetSession) {
      this.#store.bindScope(chatId, targetSession.sessionId, this.#now());
      await this.#sendCurrent(chatId);
      return;
    }
    await this.#createAndActivateOnHost(chatId, false, targetHostId);
  }

  async #sendRenamePrompt(chatId: string, sessionId?: string): Promise<void> {
    const session = sessionId ? this.#store.getSession(sessionId) : this.#activeSession(chatId);
    if (!session || session.projectId !== this.#projectId || session.status !== "ACTIVE") {
      throw new Error("session is unavailable");
    }
    await this.#feishu.sendCard(chatId, renameSessionCard(session));
  }

  #activeSession(chatId: string) {
    const sessionId = this.#store.getActiveSessionId(chatId);
    const session = sessionId ? this.#store.getSession(sessionId) : null;
    if (!session || session.projectId !== this.#projectId || session.status !== "ACTIVE") {
      throw new Error("no active session");
    }
    return session;
  }

  #currentHostId(chatId: string): string {
    if (!this.#executionHosts) return "legacy";
    const sessionId = this.#store.getActiveSessionId(chatId);
    const session = sessionId ? this.#store.getSession(sessionId) : null;
    return session
      ? this.#executionHosts.hostIdForThread(session.codexThreadId)
      : this.#executionHosts.defaultHostId;
  }

  #hostIdForThread(threadId: string): string {
    return this.#executionHosts?.hostIdForThread(threadId) ?? "legacy";
  }

  #workspacePathForHost(hostId: string): string {
    return this.#executionHosts?.workspacePathForHost(hostId) ?? this.#workspacePath;
  }

  #hostSummary(hostId: string) {
    const host = this.#executionHosts?.listHosts().find((candidate) => candidate.hostId === hostId);
    if (!host) throw new Error(`unknown execution host: ${hostId}`);
    return host;
  }
}

const KNOWN_ACTIONS = new Set([
  "session.new",
  "session.readonly",
  "session.fork",
  "session.select",
  "session.switch",
  "session.rename.prompt",
  "session.rename",
  "session.archive",
  "run.stop",
  "execution_host.switch",
]);

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing ${name}`);
  return value.trim();
}

function pageValue(value: unknown): number {
  if (value === undefined) return 0;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 0 || page > 1_000) {
    throw new Error("invalid page");
  }
  return page;
}

function infoToast(content: string): CallbackResponse {
  return { toast: { type: "info", content } };
}

function errorToast(content: string): CallbackResponse {
  return { toast: { type: "error", content } };
}
