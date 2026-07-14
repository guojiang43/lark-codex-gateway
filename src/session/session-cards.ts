import type { ActiveRunRecord, SessionListRecord, SessionRecord } from "../state/state-store.js";

type Card = Record<string, unknown>;

const text = (content: string) => ({ tag: "plain_text", content });
const markdown = (content: string, elementId?: string) => ({
  tag: "markdown",
  content,
  ...(elementId ? { element_id: elementId } : {}),
});
const callbackButton = (
  label: string,
  value: Record<string, string>,
  elementId: string,
  type: "default" | "primary" | "danger" = "default",
  confirm?: { title: string; text: string },
) => ({
  tag: "button",
  element_id: elementId,
  text: text(label),
  type,
  size: "small",
  behaviors: [{ type: "callback", value }],
  ...(confirm
    ? {
        confirm: {
          title: text(confirm.title),
          text: text(confirm.text),
        },
      }
    : {}),
});

function baseCard(title: string, elements: unknown[], template = "blue"): Card {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    header: { template, title: text(title) },
    body: {
      direction: "vertical",
      vertical_spacing: "8px",
      padding: "12px",
      elements,
    },
  };
}

export function sessionPickerCard(input: {
  projectName: string;
  sessions: SessionListRecord[];
  activeSessionId: string | null;
  page: number;
  hasNext: boolean;
  executionHostName?: string;
}): Card {
  const elements: unknown[] = [markdown(
    `**Project：** ${input.projectName}` +
      (input.executionHostName ? `\n\n**执行主机：** ${escapeMarkdown(input.executionHostName)}` : ""),
  )];
  if (input.sessions.length === 0) {
    elements.push(markdown("暂无可用 Session。"));
  }
  input.sessions.forEach((session, index) => {
    const active = session.sessionId === input.activeSessionId;
    const state = session.runState ?? "空闲";
    elements.push(
      markdown(
        `${active ? "🟢 **当前**" : "⚪️"} ${escapeMarkdown(session.title)}\n\n` +
          `状态：${state}\n\n最后活跃：${formatTime(session.updatedAt)}`,
      ),
      callbackButton(
        active ? "当前 Session" : "切换到此 Session",
        { action: "session.switch", session_id: session.sessionId },
        `switch_${index}`,
        active ? "primary" : "default",
      ),
    );
  });
  elements.push(
    callbackButton("新建会话", { action: "session.new" }, "new_session", "primary"),
  );
  if (input.page > 0) {
    elements.push(callbackButton(
      "上一页",
      { action: "session.select", page: String(input.page - 1) },
      "previous_page",
    ));
  }
  if (input.hasNext) {
    elements.push(callbackButton(
      "下一页",
      { action: "session.select", page: String(input.page + 1) },
      "next_page",
    ));
  }
  return baseCard("Codex · Sessions", elements);
}

export function currentSessionCard(input: {
  projectName: string;
  session: SessionRecord;
  activeRun: ActiveRunRecord | null;
  executionHostName?: string;
}): Card {
  const runState = input.activeRun?.state ?? "空闲";
  const elements: unknown[] = [
    markdown(
      `**Session：** ${escapeMarkdown(input.session.title)}\n\n` +
        `**Project：** ${input.projectName}\n\n` +
        (input.executionHostName ? `**执行主机：** ${escapeMarkdown(input.executionHostName)}\n\n` : "") +
        `**状态：** ${runState}`,
    ),
    callbackButton(
      "重命名",
      { action: "session.rename.prompt", session_id: input.session.sessionId },
      "rename_prompt",
    ),
    callbackButton(
      "归档",
      { action: "session.archive", session_id: input.session.sessionId },
      "archive_session",
      "danger",
      { title: "归档当前 Session", text: "历史不会删除，但会从默认列表隐藏。" },
    ),
  ];
  if (input.activeRun) {
    elements.push(
      callbackButton("停止生成", { action: "run.stop" }, "stop_run", "danger"),
    );
  }
  return baseCard("Codex · 当前状态", elements, input.activeRun ? "orange" : "green");
}

export function renameSessionCard(session: SessionRecord): Card {
  return baseCard("重命名 Session", [
    {
      tag: "form",
      element_id: "rename_form",
      direction: "vertical",
      vertical_spacing: "8px",
      elements: [
        {
          tag: "input",
          name: "title",
          required: true,
          default_value: session.title,
          label: text("Session 标题"),
          placeholder: text("请输入新标题"),
          max_length: 80,
        },
        {
          tag: "button",
          name: "rename_submit",
          form_action_type: "submit",
          text: text("保存"),
          type: "primary",
          behaviors: [
            {
              type: "callback",
              value: { action: "session.rename", session_id: session.sessionId },
            },
          ],
        },
      ],
    },
  ]);
}

export function helpCard(): Card {
  return baseCard("Codex · 帮助", [
    markdown(
      "直接发送消息，会进入当前 Session。\n\n" +
        "- **新建会话**：创建空白 Codex Session\n" +
        "- **切换会话**：选择已有 Session 继续对话\n" +
        "- **停止生成**：中断当前 chat 最近的活动 turn",
    ),
    callbackButton("选择 Session", { action: "session.select" }, "select_session", "primary"),
  ]);
}

export function operationResultCard(title: string, content: string, success = true): Card {
  return baseCard(title, [markdown(content)], success ? "green" : "red");
}

export function healthCard(input: {
  projectName: string;
  queueBusy: boolean;
  sessionCount: number;
  uptimeMs: number;
  codexStatus: string;
  gatewayHostName?: string;
  currentExecutionHostId?: string;
  executionHosts?: Array<{
    hostId: string;
    displayName: string;
    available: boolean;
    detail: string;
  }>;
}): Card {
  const queue = input.queueBusy ? "忙碌" : "空闲";
  const uptimeMinutes = Math.max(0, Math.floor(input.uptimeMs / 60_000));
  const currentHost = input.executionHosts?.find((host) => host.hostId === input.currentExecutionHostId);
  const elements: unknown[] = [
    markdown(
      `**Feishu WebSocket：** 已连接\n\n` +
        `**Gateway：** 正常 · 已运行 ${uptimeMinutes} 分钟\n\n` +
        `**Codex app-server：** ${escapeMarkdown(input.codexStatus)}\n\n` +
        (input.gatewayHostName ? `**飞书入口：** ${escapeMarkdown(input.gatewayHostName)}\n\n` : "") +
        (currentHost ? `**当前执行主机：** ${escapeMarkdown(currentHost.displayName)}\n\n` : "") +
        `**目标 Project：** ${escapeMarkdown(input.projectName)}\n\n` +
        `**Project 队列：** ${queue}\n\n` +
        `**活动 Session：** ${input.sessionCount}`,
    ),
  ];
  for (const host of input.executionHosts ?? []) {
    if (host.hostId === input.currentExecutionHostId) continue;
    elements.push(callbackButton(
      `切换到 ${host.displayName}`,
      { action: "execution_host.switch", target_host_id: host.hostId },
      `host_${host.hostId}`,
      host.available ? "primary" : "default",
      {
        title: `切换到 ${host.displayName}`,
        text: host.available
          ? "切换后只展示并使用该主机的本地 Session。"
          : `${host.displayName} 当前离线，点击后不会改变当前 Session。`,
      },
    ));
  }
  return baseCard("Codex · 运行状态", elements, input.queueBusy ? "orange" : "green");
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("_", "\\_");
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
}
