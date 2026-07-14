import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type { ApprovalDecision, ApprovalRequest } from "../codex/app-server-client.js";
import type { CardActionEvent, CallbackResponse } from "../session/session-controller.js";
import type { ApprovalRunContext, StateStore } from "../state/state-store.js";
import { approvalCard, approvalResultCard } from "./approval-cards.js";

export interface ApprovalFeishuPort {
  sendCard(chatId: string, card: Record<string, unknown>): Promise<{ cardId: string; messageId: string }>;
  addReaction(messageId: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

interface PendingApproval {
  approvalId: string;
  run: ApprovalRunContext;
  resolve: (decision: ApprovalDecision) => void;
  timer?: NodeJS.Timeout;
  settling?: boolean;
}

interface Options {
  store: StateStore;
  feishu: ApprovalFeishuPort;
  workspacePath: string;
  additionalWorkspacePaths?: string[];
  allowedSenderId: string;
  approvalTimeoutMs?: number;
  now?: () => number;
  id?: () => string;
  onError?: (error: Error) => void;
}

export class ApprovalController {
  readonly #store: StateStore;
  readonly #feishu: ApprovalFeishuPort;
  readonly #workspacePaths: string[];
  readonly #allowedSenderId: string;
  readonly #approvalTimeoutMs: number;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #onError: (error: Error) => void;
  readonly #pending = new Map<string, PendingApproval>();
  readonly #tasks = new Set<Promise<void>>();

  constructor(options: Options) {
    this.#store = options.store;
    this.#feishu = options.feishu;
    this.#workspacePaths = [options.workspacePath, ...(options.additionalWorkspacePaths ?? [])]
      .map((path) => resolve(path));
    this.#allowedSenderId = options.allowedSenderId;
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    this.#now = options.now ?? Date.now;
    this.#id = options.id ?? randomUUID;
    this.#onError = options.onError ?? (() => {});
  }

  async requestDecision(request: ApprovalRequest): Promise<ApprovalDecision> {
    const threadId = stringValue(request.params.threadId);
    const turnId = stringValue(request.params.turnId);
    if (
      !threadId ||
      !turnId ||
      !this.#isAllowedPath(request.params.cwd) ||
      !this.#isAllowedPath(request.params.grantRoot) ||
      this.#requestsOutsideWrite(request.params.additionalPermissions)
    ) return "decline";
    const run = await this.#findRun(threadId, turnId);
    if (!run || run.state !== "RUNNING") return "decline";

    const approvalId = this.#id();
    const expiresAt = this.#now() + this.#approvalTimeoutMs;
    this.#store.createApproval({
      approvalId,
      runId: run.runId,
      requestMethod: request.method,
      expiresAt,
    });
    this.#store.transitionRun(run.runId, "WAITING_APPROVAL", this.#now());

    const decision = new Promise<ApprovalDecision>((resolveDecision) => {
      this.#pending.set(approvalId, { approvalId, run, resolve: resolveDecision });
    });

    try {
      await this.#removeProcessingReaction(run);
      await this.#feishu.sendCard(run.chatId, approvalCard({
        approvalId,
        requestMethod: request.method,
        ...(stringValue(request.params.cwd) ? { cwd: stringValue(request.params.cwd)! } : {}),
        ...(stringValue(request.params.command) ? { command: stringValue(request.params.command)! } : {}),
        ...(stringValue(request.params.reason) ? { reason: stringValue(request.params.reason)! } : {}),
      }));
      const pending = this.#pending.get(approvalId);
      if (pending) {
        pending.timer = setTimeout(() => {
          this.#schedule(() => this.#settle(approvalId, "decline", "timeout"));
        }, this.#approvalTimeoutMs);
      }
    } catch (error) {
      this.#onError(normalizeError(error));
      await this.#settle(approvalId, "decline", "timeout");
    }
    return decision;
  }

  handleCardAction(event: CardActionEvent): CallbackResponse | null {
    if (event.actionValue.action !== "approval.decide") return null;
    if (event.operatorId !== this.#allowedSenderId) {
      return { toast: { type: "error", content: "没有审批权限" } };
    }
    const approvalId = stringValue(event.actionValue.approval_id);
    const decision = event.actionValue.decision;
    if (!approvalId || (decision !== "accept" && decision !== "decline")) {
      return { toast: { type: "error", content: "审批参数无效" } };
    }
    const pending = this.#pending.get(approvalId);
    if (!pending || pending.settling) {
      return { toast: { type: "info", content: "该审批已处理或已失效" } };
    }
    if (!this.#store.claimInteractionEvent({
      eventId: event.eventId,
      eventKind: "card",
      operatorId: event.operatorId,
      receivedAt: event.receivedAt ?? this.#now(),
    })) {
      return { toast: { type: "info", content: "该操作已处理" } };
    }
    pending.settling = true;
    this.#schedule(() => this.#settle(approvalId, decision, "user"));
    return { toast: { type: "success", content: decision === "accept" ? "已允许一次" : "已拒绝" } };
  }

  async cancelRun(runId: string): Promise<void> {
    const approval = [...this.#pending.values()].find((entry) => entry.run.runId === runId);
    if (approval) await this.#settle(approval.approvalId, "cancel", "stop");
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#tasks]);
  }

  async #findRun(threadId: string, turnId: string): Promise<ApprovalRunContext | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const run = this.#store.getApprovalRunContext(threadId, turnId)
        ?? this.#store.getApprovalRunContext(rawThreadId(threadId), turnId);
      if (run) return run;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    return null;
  }

  async #removeProcessingReaction(run: ApprovalRunContext): Promise<void> {
    if (!run.reactionId) return;
    await this.#feishu.removeReaction(run.messageId, run.reactionId);
    this.#store.clearReaction(run.messageId, this.#now());
  }

  async #settle(
    approvalId: string,
    decision: ApprovalDecision,
    source: "user" | "timeout" | "stop",
  ): Promise<void> {
    const pending = this.#pending.get(approvalId);
    if (!pending) return;
    this.#pending.delete(approvalId);
    if (pending.timer) clearTimeout(pending.timer);
    if (!this.#store.decideApproval(approvalId, decision, this.#now())) return;

    if (decision !== "cancel") {
      const run = this.#store.getRun(pending.run.runId);
      if (run?.state === "WAITING_APPROVAL") {
        this.#store.transitionRun(run.runId, "RUNNING", this.#now());
      }
      try {
        const reactionId = await this.#feishu.addReaction(pending.run.messageId);
        this.#store.recordReaction({
          messageId: pending.run.messageId,
          reactionId,
          runId: pending.run.runId,
          now: this.#now(),
        });
      } catch (error) {
        this.#onError(normalizeError(error));
      }
    }

    pending.resolve(decision);
    try {
      await this.#feishu.sendCard(pending.run.chatId, approvalResultCard(decision, source));
    } catch (error) {
      this.#onError(normalizeError(error));
    }
  }

  #schedule(work: () => Promise<void>): void {
    const task = work().catch((error: unknown) => this.#onError(normalizeError(error)));
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }

  #isAllowedPath(value: unknown): boolean {
    const cwd = stringValue(value);
    if (!cwd) return true;
    if (!isAbsolute(cwd)) return false;
    return this.#workspacePaths.some((workspacePath) => {
      const path = relative(workspacePath, resolve(cwd));
      return path === "" || (!path.startsWith("..") && !isAbsolute(path));
    });
  }

  #requestsOutsideWrite(value: unknown): boolean {
    const additional = objectValue(value);
    const fileSystem = objectValue(additional?.fileSystem);
    if (!fileSystem) return false;
    const legacyWrites = Array.isArray(fileSystem.write) ? fileSystem.write : [];
    if (legacyWrites.some((path) => !this.#isAllowedPath(path))) return true;
    const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries : [];
    return entries.some((rawEntry) => {
      const entry = objectValue(rawEntry);
      if (entry?.access !== "write") return false;
      const path = objectValue(entry.path);
      if (!path) return true;
      if (path.type === "path") return !this.#isAllowedPath(path.path);
      if (path.type === "glob_pattern") return !this.#isAllowedPath(path.pattern);
      if (path.type === "special") {
        const special = objectValue(path.value);
        return special?.kind !== "project_roots";
      }
      return true;
    });
  }
}

function rawThreadId(threadId: string): string {
  const separator = threadId.indexOf("::");
  return separator > 0 ? threadId.slice(separator + 2) : threadId;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
