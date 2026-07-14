import { describe, expect, it } from "vitest";

import { CardStreamWriter } from "../src/gateway/card-stream-writer.js";
import type { FeishuPort } from "../src/gateway/gateway-service.js";

class FakePagedFeishu implements FeishuPort {
  readonly updates: Array<{ cardId: string; content: string; sequence: number }> = [];
  readonly finishes: Array<{ cardId: string; content: string; sequence: number; status: string }> = [];
  readonly created: string[] = [];

  async addReaction(): Promise<string> { return "reaction"; }
  async removeReaction(): Promise<void> {}
  async sendRichFallback(): Promise<void> {}
  async downloadAttachment(): Promise<never> { throw new Error("unused"); }
  async createAnswerCard(chatId: string): Promise<string> {
    this.created.push(chatId);
    return `card-${this.created.length + 1}`;
  }
  async updateAnswerCard(cardId: string, content: string, sequence: number): Promise<void> {
    this.updates.push({ cardId, content, sequence });
  }
  async finishAnswerCard(cardId: string, content: string, sequence: number, status: string): Promise<void> {
    this.finishes.push({ cardId, content, sequence, status });
  }
}

describe("CardStreamWriter pagination", () => {
  it("replaces transient progress with the final answer before finishing", async () => {
    const feishu = new FakePagedFeishu();
    const writer = new CardStreamWriter(feishu, "card-1", 100);

    writer.append("正在检查\n\n继续检查");
    writer.replace("最终结论");
    await writer.finish("completed");

    expect(writer.content).toBe("最终结论");
    expect(feishu.updates.at(-1)?.content).toBe("最终结论");
    expect(feishu.finishes.at(-1)?.content).toBe("最终结论");
  });

  it("creates continuation cards before a UTF-8-safe page exceeds its byte budget", async () => {
    const feishu = new FakePagedFeishu();
    const writer = new CardStreamWriter(feishu, "card-1", 100, {
      chatId: "chat-1",
      maxPageBytes: 12,
    });

    writer.append("你好世界ABCDE");
    await writer.finish("completed");

    expect(feishu.created).toEqual(["chat-1"]);
    expect(feishu.updates.map((update) => update.content)).toEqual(["你好世界", "ABCDE"]);
    expect(feishu.updates.every((update) => Buffer.byteLength(update.content, "utf8") <= 12)).toBe(true);
    expect(feishu.finishes.map((finish) => finish.cardId)).toEqual(["card-1", "card-2"]);
    expect(writer.content).toBe("你好世界ABCDE");
  });
});
