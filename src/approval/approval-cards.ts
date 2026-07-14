type Card = Record<string, unknown>;

const text = (content: string) => ({ tag: "plain_text", content });
const markdown = (content: string) => ({ tag: "markdown", content });
const callbackButton = (
  label: string,
  approvalId: string,
  decision: "accept" | "decline",
  type: "primary" | "danger",
) => ({
  tag: "button",
  text: text(label),
  type,
  behaviors: [{
    type: "callback",
    value: { action: "approval.decide", approval_id: approvalId, decision },
  }],
});

export function approvalCard(input: {
  approvalId: string;
  requestMethod: string;
  cwd?: string;
  command?: string;
  reason?: string;
}): Card {
  const kind = input.requestMethod.includes("commandExecution")
    ? "命令执行"
    : input.requestMethod.includes("fileChange")
      ? "文件变更"
      : "权限提升";
  const details = [
    `**动作：** ${kind}`,
    input.cwd ? `**目录：** ${escapeMarkdown(input.cwd)}` : null,
    input.reason ? `**原因：** ${escapeMarkdown(redactSensitive(input.reason))}` : null,
    input.command
      ? `**命令：**\n\n\`\`\`text\n${escapeFence(redactSensitive(input.command))}\n\`\`\``
      : null,
    "本次授权只对当前请求生效，不会形成永久规则。",
  ].filter((value): value is string => Boolean(value));
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "Codex 正在等待一次性审批" } },
    header: { template: "orange", title: text("Codex · 等待审批") },
    body: {
      direction: "vertical",
      vertical_spacing: "8px",
      padding: "12px",
      elements: [
        markdown(details.join("\n\n")),
        callbackButton("允许一次", input.approvalId, "accept", "primary"),
        callbackButton("拒绝", input.approvalId, "decline", "danger"),
      ],
    },
  };
}

export function approvalResultCard(
  decision: "accept" | "decline" | "cancel",
  source: "user" | "timeout" | "stop",
): Card {
  const content = decision === "accept"
    ? "已允许一次，任务继续执行。"
    : source === "timeout"
      ? "审批已超时并自动拒绝，任务继续收口。"
      : source === "stop"
        ? "任务已停止，本次审批失效。"
        : "已拒绝本次操作，任务继续收口。";
  return {
    schema: "2.0",
    config: { summary: { content } },
    header: { template: decision === "accept" ? "green" : "grey", title: text("Codex · 审批结果") },
    body: { elements: [markdown(content)] },
  };
}

export function redactSensitive(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s'\"]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|secret|password)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s&]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|token|secret|password)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|ghp|github_pat|xoxb|xapp)-?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .slice(0, 4_000);
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("_", "\\_");
}

function escapeFence(value: string): string {
  return value.replaceAll("```", "``\u200b`");
}
