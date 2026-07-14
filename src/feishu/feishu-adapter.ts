import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as lark from "@larksuiteoapi/node-sdk";

import type {
  DownloadedAttachment,
  FeishuPort,
  InboundAttachment,
} from "../gateway/gateway-service.js";

interface ApiResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
  card_id?: string;
}

export class FeishuAdapter implements FeishuPort {
  readonly client: lark.Client;
  readonly #attachmentRoot: string;
  readonly #maxAttachmentBytes: number;

  constructor(input: {
    appId: string;
    appSecret: string;
    attachmentRoot?: string;
    maxAttachmentBytes?: number;
    client?: lark.Client;
  }) {
    this.client = input.client ?? new lark.Client({
      appId: input.appId,
      appSecret: input.appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
    });
    this.#attachmentRoot = input.attachmentRoot ?? ".data/attachments";
    this.#maxAttachmentBytes = input.maxAttachmentBytes ?? 25 * 1024 * 1024;
  }

  async addReaction(messageId: string): Promise<string> {
    const response = await this.client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: "OnIt" } },
    });
    assertSuccess(response);
    const reactionId = response.data?.reaction_id;
    if (!reactionId) throw new Error("Feishu reaction create returned no reaction_id");
    return reactionId;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const response = await this.client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    assertSuccess(response);
  }

  async createAnswerCard(chatId: string, title?: string): Promise<string> {
    const card = buildAnswerCard(title);
    const { cardId } = await this.sendCard(chatId, card);
    return cardId;
  }

  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
  ): Promise<{ cardId: string; messageId: string }> {
    const create = (await this.client.request({
      method: "POST",
      url: "/open-apis/cardkit/v1/cards",
      data: { type: "card_json", data: JSON.stringify(card) },
    })) as ApiResponse;
    assertSuccess(create);
    const cardId = (create.data?.card_id ?? create.card_id) as string | undefined;
    if (!cardId) throw new Error("CardKit create returned no card_id");

    const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
    const sent = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content },
    });
    assertSuccess(sent);
    const messageId = sent.data?.message_id;
    if (!messageId) throw new Error("Feishu message create returned no message_id");
    return { cardId, messageId };
  }

  async updateAnswerCard(cardId: string, content: string, sequence: number): Promise<void> {
    const response = (await this.client.request({
      method: "PUT",
      url: `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/answer/content`,
      data: { content, sequence, uuid: randomUUID() },
    })) as ApiResponse;
    assertSuccess(response);
  }

  async finishAnswerCard(
    cardId: string,
    content: string,
    sequence: number,
    status: string,
    title?: string,
  ): Promise<void> {
    const card = buildFinalAnswerCard(content, status, title);
    const response = (await this.client.request({
      method: "PUT",
      url: `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`,
      data: {
        card: { type: "card_json", data: JSON.stringify(card) },
        sequence,
        uuid: randomUUID(),
      },
    })) as ApiResponse;
    assertSuccess(response);
  }

  async sendRichFallback(chatId: string, title: string, content: string): Promise<void> {
    const paragraphs = content.slice(0, 20_000).split("\n").map((line) => [
      { tag: "text", text: line || " " },
    ]);
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "post",
        content: JSON.stringify({ zh_cn: { title, content: paragraphs } }),
      },
    });
    assertSuccess(response);
  }

  async downloadAttachment(
    messageId: string,
    attachment: InboundAttachment,
  ): Promise<DownloadedAttachment> {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(attachment.fileKey)) {
      throw new Error("invalid Feishu attachment key");
    }
    await mkdir(this.#attachmentRoot, { recursive: true, mode: 0o700 });
    await chmod(this.#attachmentRoot, 0o700);
    const directory = join(this.#attachmentRoot, randomUUID());
    await mkdir(directory, { mode: 0o700 });
    try {
      const resource = await this.client.im.v1.messageResource.get({
        params: { type: attachment.kind },
        path: { message_id: messageId, file_key: attachment.fileKey },
      });
      const contentLength = Number(headerValue(resource.headers, "content-length"));
      if (Number.isFinite(contentLength) && contentLength > this.#maxAttachmentBytes) {
        throw new Error("Feishu attachment exceeds the gateway size limit");
      }
      const extension = attachmentExtension(
        attachment,
        headerValue(resource.headers, "content-type"),
      );
      const filePath = join(directory, `resource${extension}`);
      let bytes = 0;
      const limiter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          bytes += chunk.length;
          callback(
            bytes > this.#maxAttachmentBytes
              ? new Error("Feishu attachment exceeds the gateway size limit")
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        resource.getReadableStream(),
        limiter,
        createWriteStream(filePath, { flags: "wx", mode: 0o600 }),
      );
      return {
        path: filePath,
        cleanup: () => rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

export async function resetAttachmentRoot(root: string): Promise<void> {
  const normalized = resolve(root);
  if (basename(normalized) !== "attachments") {
    throw new Error("refusing to reset an attachment root without the attachments basename");
  }
  await rm(normalized, { recursive: true, force: true });
  await mkdir(normalized, { recursive: true, mode: 0o700 });
  await chmod(normalized, 0o700);
}

export function buildAnswerCard(title = "Codex"): Record<string, unknown> {
  const button = (
    label: string,
    elementId: string,
    value: Record<string, string>,
    type: "default" | "danger" = "default",
  ) => ({
    tag: "button",
    element_id: elementId,
    text: { tag: "plain_text", content: label },
    type,
    size: "small",
    behaviors: [{ type: "callback", value }],
  });
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: "正在处理" },
    },
    config: {
      streaming_mode: true,
      update_multi: true,
      summary: { content: `${title} 正在处理你的任务` },
      streaming_config: {
        print_frequency_ms: { default: 70, android: 70, ios: 70, pc: 70 },
        print_step: { default: 1, android: 1, ios: 1, pc: 1 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [
        { tag: "markdown", content: "正在分析…", element_id: "answer" },
        button("停止生成", "stop_run", { action: "run.stop" }, "danger"),
      ],
    },
  };
}

export function buildFinalAnswerCard(
  content: string,
  status: string,
  title = "Codex",
): Record<string, unknown> {
  const presentation = finalStatusPresentation(status);
  return {
    schema: "2.0",
    header: {
      template: presentation.template,
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: presentation.label },
    },
    config: {
      streaming_mode: false,
      update_multi: true,
      summary: { content: `${title} · ${presentation.label}` },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: content || presentation.defaultContent,
          element_id: "answer",
        },
      ],
    },
  };
}

function finalStatusPresentation(status: string): {
  label: string;
  template: "green" | "red" | "orange" | "blue";
  defaultContent: string;
} {
  switch (status) {
    case "completed":
      return { label: "已完成", template: "green", defaultContent: "任务已完成。" };
    case "cancelled":
    case "interrupted":
      return { label: "已停止", template: "orange", defaultContent: "任务已停止。" };
    case "continued":
      return { label: "回答续页", template: "blue", defaultContent: "回答将在下一张卡片继续。" };
    case "failed":
    default:
      return { label: "执行失败", template: "red", defaultContent: "任务执行失败，请稍后重试。" };
  }
}

function assertSuccess(response: { code?: number | undefined; msg?: string | undefined }): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu API failed: code=${response.code}, message=${response.msg ?? "unknown"}`);
  }
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const value = (headers as Record<string, unknown>)[name];
  if (Array.isArray(value)) return value[0] === undefined ? undefined : String(value[0]);
  return value === undefined ? undefined : String(value);
}

function attachmentExtension(attachment: InboundAttachment, contentType?: string): string {
  if (attachment.kind === "file" && attachment.displayName) {
    const extension = extname(attachment.displayName);
    if (/^\.[A-Za-z0-9]{1,10}$/.test(extension)) return extension.toLowerCase();
  }
  switch (contentType?.split(";")[0]?.trim().toLowerCase()) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "application/pdf": return ".pdf";
    default: return attachment.kind === "image" ? ".img" : ".bin";
  }
}
