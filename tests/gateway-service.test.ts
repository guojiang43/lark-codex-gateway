import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatAnswerCardTitle,
  GatewayService,
  type CodexDeltaMetadata,
  type CodexRuntime,
  type DownloadedAttachment,
  type FeishuPort,
  type InboundAttachment,
} from "../src/gateway/gateway-service.js";
import { ProjectQueue } from "../src/queue/project-queue.js";
import { StateStore } from "../src/state/state-store.js";
import {
  ExecutionHostUnavailableError,
  type ExecutionHostDirectory,
} from "../src/codex/host-routing-runtime.js";

class FakeFeishu implements FeishuPort {
  readonly events: string[] = [];
  readonly updates: Array<{ cardId: string; content: string; sequence: number }> = [];
  readonly fallbacks: Array<{ chatId: string; title: string; content: string }> = [];
  readonly answerCardTitles: string[] = [];
  failCardCreation = false;

  async addReaction(messageId: string): Promise<string> {
    this.events.push(`reaction:add:${messageId}`);
    return "reaction-1";
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.events.push(`reaction:remove:${messageId}:${reactionId}`);
  }

  async createAnswerCard(chatId: string, title?: string): Promise<string> {
    if (this.failCardCreation) throw new Error("CardKit unavailable");
    this.answerCardTitles.push(title ?? "");
    this.events.push(`card:create:${chatId}`);
    return "card-1";
  }

  async sendRichFallback(chatId: string, title: string, content: string): Promise<void> {
    this.fallbacks.push({ chatId, title, content });
  }

  async updateAnswerCard(cardId: string, content: string, sequence: number): Promise<void> {
    this.events.push(`card:update:${sequence}`);
    this.updates.push({ cardId, content, sequence });
  }

  async finishAnswerCard(
    cardId: string,
    content: string,
    sequence: number,
    status: string,
    title?: string,
  ): Promise<void> {
    this.answerCardTitles.push(title ?? "");
    this.events.push(`card:finish:${status}:${sequence}`);
    this.updates.push({ cardId, content, sequence });
  }

  async downloadAttachment(
    _messageId: string,
    attachment: InboundAttachment,
  ): Promise<DownloadedAttachment> {
    this.events.push(`attachment:download:${attachment.kind}:${attachment.fileKey}`);
    const path = "/tmp/xiaowang-test-image.png";
    return {
      path,
      cleanup: async () => {
        this.events.push(`attachment:cleanup:${path}`);
      },
    };
  }
}

class FakeCodex implements CodexRuntime {
  calls = 0;
  startCalls = 0;
  readonly started: Array<{ workspacePath: string; readOnly?: boolean }> = [];
  shouldFail = false;
  unavailableHost: string | undefined;
  resumeResult = "thread-1";
  readonly resumed: Array<{ threadId: string; workspacePath: string; readOnly?: boolean }> = [];
  onRunStarted: (() => void) | undefined;
  lastLocalImages: string[] | undefined;
  lastThreadId: string | undefined;
  phasedOutput = false;

  async startSession(input: { workspacePath: string; readOnly?: boolean }): Promise<string> {
    this.startCalls += 1;
    this.started.push(input);
    return "thread-created";
  }

  async forkSession(): Promise<string> {
    return "thread-forked";
  }

  async resumeSession(input: { threadId: string; workspacePath: string; readOnly?: boolean }): Promise<string> {
    this.resumed.push(input);
    return this.resumeResult;
  }

  async archiveSession(): Promise<void> {}

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
    this.calls += 1;
    this.lastThreadId = input.threadId;
    this.lastLocalImages = input.localImages;
    input.onTurnStarted("turn-1");
    this.onRunStarted?.();
    if (this.phasedOutput) {
      input.onDelta("正在检查", { itemId: "comment-1", phase: "commentary" });
      input.onDelta("继续检查", { itemId: "comment-2", phase: "commentary" });
      await new Promise((resolve) => setTimeout(resolve, 110));
      input.onDelta("最终结论", { itemId: "final-1", phase: "final_answer" });
    } else {
      input.onDelta("第一段");
      input.onDelta("，第二段");
    }
    if (this.unavailableHost) throw new ExecutionHostUnavailableError(this.unavailableHost, "MacBook", "离线");
    if (this.shouldFail) throw new Error("codex failed");
    return { turnId: "turn-1", status: "completed" };
  }

  async interrupt(): Promise<void> {}
}

class FakeRunApprovals {
  readonly cancelled: string[] = [];
  async cancelRun(runId: string): Promise<void> {
    this.cancelled.push(runId);
  }
}

function fixture(options: { executionHosts?: ExecutionHostDirectory; threadId?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xiaowang-gateway-"));
  const store = new StateStore(join(dir, "gateway.db"));
  store.upsertProject({ projectId: "p", displayName: "P", workspacePath: dir, hostId: "h" });
  store.createSession({
    sessionId: "s",
    codexThreadId: options.threadId ?? "thread-1",
    projectId: "p",
    title: "默认任务",
    now: 1,
  });
  store.bindScope("chat-1", "s", 2);
  const feishu = new FakeFeishu();
  const codex = new FakeCodex();
  const approvals = new FakeRunApprovals();
  const gateway = new GatewayService({
    store,
    queue: new ProjectQueue(),
    feishu,
    codex,
    approvals,
    projectId: "p",
    projectDisplayName: "P",
    workspacePath: dir,
    allowedSenderId: "allowed-user",
    ...(options.executionHosts ? { executionHosts: options.executionHosts } : {}),
    streamIntervalMs: 5,
    id: () => "run-1",
  });
  return { store, feishu, codex, approvals, gateway };
}

const message = {
  eventId: "event-1",
  messageId: "message-1",
  chatId: "chat-1",
  chatType: "p2p" as const,
  senderId: "allowed-user",
  text: "请检查项目",
  receivedAt: 10,
};

describe("GatewayService", () => {
  it("formats answer-card titles as Project · Session without duplicating legacy project prefixes", () => {
    expect(formatAnswerCardTitle("P", "默认任务")).toBe("P · 默认任务");
    expect(formatAnswerCardTitle("P", "P · 默认任务")).toBe("P · 默认任务");
  });

  it("separates commentary paragraphs and keeps only the final answer when the turn completes", async () => {
    const { gateway, codex, feishu, store } = fixture();
    codex.phasedOutput = true;

    const result = await gateway.handleMessage(message);

    expect(result.kind).toBe("completed");
    expect(feishu.updates.some((update) => update.content === "正在检查\n\n继续检查")).toBe(true);
    expect(feishu.updates.at(-1)?.content).toBe("最终结论");
    expect(feishu.updates.at(-1)?.content).not.toContain("正在检查");
    store.close();
  });

  it("refreshes the native MacBook Codex task after a completed turn", async () => {
    const refreshedThreads: string[] = [];
    const executionHosts: ExecutionHostDirectory = {
      defaultHostId: "m4",
      listHosts: () => [],
      hostIdForThread: () => "macbook",
      workspacePathForHost: () => "/work/macbook",
      refreshThread: async (threadId) => { refreshedThreads.push(threadId); },
    };
    const { gateway, codex, store } = fixture({
      executionHosts,
      threadId: "macbook::thread-1",
    });
    codex.resumeResult = "macbook::thread-1";

    const result = await gateway.handleMessage(message);

    expect(result.kind).toBe("completed");
    expect(refreshedThreads).toEqual(["macbook::thread-1"]);
    store.close();
  });

  it("runs one turn, streams the accumulated answer, and always removes the reaction", async () => {
    const { gateway, feishu, store } = fixture();

    const result = await gateway.handleMessage(message);

    expect(result.kind).toBe("completed");
    expect(feishu.updates.at(-1)?.content).toBe("第一段，第二段");
    expect(feishu.answerCardTitles).toEqual(["P · 默认任务", "P · 默认任务"]);
    expect(feishu.events[0]).toBe("reaction:add:message-1");
    expect(feishu.events.at(-1)).toBe("reaction:remove:message-1:reaction-1");
    expect(store.getRun(result.runId ?? "")?.state).toBe("COMPLETED");
    expect(store.getRunCardEventStats(result.runId ?? "")).toMatchObject({
      updateCount: 1,
      finishCount: 1,
      maxSequence: 2,
    });
    store.close();
  });

  it("resumes a persisted thread before starting a turn and replaces a lost empty thread", async () => {
    const { gateway, codex, store } = fixture();
    codex.resumeResult = "thread-replacement";

    const result = await gateway.handleMessage(message);

    expect(result.kind).toBe("completed");
    expect(codex.resumed).toEqual([{
      threadId: "thread-1",
      workspacePath: expect.any(String),
      readOnly: false,
    }]);
    expect(codex.lastThreadId).toBe("thread-replacement");
    expect(store.getSession("s")?.codexThreadId).toBe("thread-replacement");
    store.close();
  });

  it("materializes a pending Session exactly once when its first message arrives", async () => {
    const { gateway, codex, store } = fixture({ threadId: "pending:s" });

    const result = await gateway.handleMessage(message);

    expect(result.kind).toBe("completed");
    expect(codex.startCalls).toBe(1);
    expect(codex.resumed).toEqual([]);
    expect(codex.lastThreadId).toBe("thread-created");
    expect(store.getSession("s")?.codexThreadId).toBe("thread-created");
    store.close();
  });

  it("materializes a pending remote Session in its selected host workspace", async () => {
    const executionHosts: ExecutionHostDirectory = {
      defaultHostId: "m4",
      listHosts: () => [],
      hostIdForThread: (threadId) => threadId.startsWith("macbook::") ? "macbook" : "m4",
      workspacePathForHost: (hostId) => `/work/${hostId}`,
    };
    const { gateway, codex, store } = fixture({
      executionHosts,
      threadId: "macbook::pending:s",
    });

    const result = await gateway.handleMessage(message);

    expect(result.kind).toBe("completed");
    expect(codex.started).toEqual([{ workspacePath: "/work/macbook", readOnly: false }]);
    expect(codex.resumed).toEqual([]);
    store.close();
  });

  it("does not execute a duplicate event twice", async () => {
    const { gateway, codex, feishu, store } = fixture();

    await gateway.handleMessage(message);
    const duplicate = await gateway.handleMessage(message);

    expect(duplicate.kind).toBe("duplicate");
    expect(codex.calls).toBe(1);
    expect(feishu.events.filter((event) => event.startsWith("reaction:add"))).toHaveLength(1);
    store.close();
  });

  it("marks a failed turn and still cleans the reaction", async () => {
    const { gateway, codex, feishu, approvals, store } = fixture();
    codex.shouldFail = true;

    const result = await gateway.handleMessage(message);

    expect(result.kind).toBe("failed");
    expect(store.getRun(result.runId ?? "")?.state).toBe("FAILED");
    expect(approvals.cancelled).toEqual(["run-1"]);
    expect(feishu.fallbacks).toEqual([]);
    expect(feishu.events.at(-1)).toBe("reaction:remove:message-1:reaction-1");
    store.close();
  });

  it("reports an offline execution host without silently falling back", async () => {
    const { gateway, codex, feishu, store } = fixture();
    codex.unavailableHost = "macbook";

    const result = await gateway.handleMessage(message);

    expect(result.kind).toBe("failed");
    expect(feishu.updates.at(-1)?.content).toContain("MacBook 当前离线");
    expect(feishu.updates.at(-1)?.content).toContain("本次任务未在网关主机自动执行");
    store.close();
  });

  it("cleans the currently recorded reaction after an approval replaces the original", async () => {
    const { gateway, codex, feishu, store } = fixture();
    codex.onRunStarted = () => {
      store.clearReaction("message-1", 20);
      store.recordReaction({ messageId: "message-1", reactionId: "reaction-2", runId: "run-1", now: 21 });
    };

    const result = await gateway.handleMessage(message);

    expect(result.kind).toBe("completed");
    expect(feishu.events.at(-1)).toBe("reaction:remove:message-1:reaction-2");
    store.close();
  });

  it("rejects non-P2P or unauthorized messages before claiming them", async () => {
    const { gateway, codex, store } = fixture();
    const result = await gateway.handleMessage({ ...message, senderId: "someone-else" });
    expect(result.kind).toBe("rejected");
    expect(codex.calls).toBe(0);
    store.close();
  });

  it("sends a rich-text fallback instead of disappearing when CardKit fails", async () => {
    const { gateway, feishu, store } = fixture();
    feishu.failCardCreation = true;

    const result = await gateway.handleMessage(message);

    expect(result.kind).toBe("failed");
    expect(feishu.fallbacks).toEqual([{
      chatId: "chat-1",
      title: "P · 默认任务 · 卡片降级",
      content: "任务执行失败，请稍后重试。",
    }]);
    expect(feishu.events.at(-1)).toBe("reaction:remove:message-1:reaction-1");
    store.close();
  });

  it("downloads attachment-only messages, passes images to Codex, and cleans temporary files", async () => {
    const { gateway, feishu, codex, store } = fixture();

    const result = await gateway.handleMessage({
      ...message,
      eventId: "event-image",
      messageId: "message-image",
      text: "",
      attachments: [{ kind: "image", fileKey: "img_v3_safe" }],
    });

    expect(result.kind).toBe("completed");
    expect(feishu.events).toContain("attachment:download:image:img_v3_safe");
    expect(codex.lastLocalImages).toEqual(["/tmp/xiaowang-test-image.png"]);
    expect(feishu.events).toContain("attachment:cleanup:/tmp/xiaowang-test-image.png");
    store.close();
  });

  it("does not pass M4-local attachment paths to a MacBook Session", async () => {
    const executionHosts: ExecutionHostDirectory = {
      defaultHostId: "m4",
      listHosts: () => [],
      hostIdForThread: (threadId) => threadId.startsWith("macbook::") ? "macbook" : "m4",
      workspacePathForHost: () => "/work",
    };
    const { gateway, feishu, codex, store } = fixture({
      executionHosts,
      threadId: "macbook::thread-1",
    });

    const result = await gateway.handleMessage({
      ...message,
      eventId: "event-remote-image",
      messageId: "message-remote-image",
      attachments: [{ kind: "image", fileKey: "img_remote" }],
    });

    expect(result.kind).toBe("failed");
    expect(codex.calls).toBe(0);
    expect(feishu.events).not.toContain("attachment:download:image:img_remote");
    expect(feishu.updates.at(-1)?.content).toContain("附件暂不支持发送到远端 worker");
    store.close();
  });
});
