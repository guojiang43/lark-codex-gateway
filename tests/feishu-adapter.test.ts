import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { FeishuAdapter, resetAttachmentRoot } from "../src/feishu/feishu-adapter.js";

function fixture(body: Buffer, headers: Record<string, string>, maxAttachmentBytes = 1024) {
  const root = mkdtempSync(join(tmpdir(), "xiaowang-attachments-"));
  const get = vi.fn(async () => ({
    headers,
    getReadableStream: () => Readable.from([body]),
  }));
  const client = { im: { v1: { messageResource: { get } } } };
  const adapter = new FeishuAdapter({
    appId: "test-app",
    appSecret: "test-secret",
    attachmentRoot: root,
    maxAttachmentBytes,
    client: client as never,
  });
  return { root, get, adapter };
}

describe("FeishuAdapter attachment download", () => {
  it("fully replaces a finished answer card so no run-time controls remain", async () => {
    const request = vi.fn(async (_input: unknown) => ({ code: 0 }));
    const adapter = new FeishuAdapter({
      appId: "test-app",
      appSecret: "test-secret",
      client: { request } as never,
    });

    await adapter.finishAnswerCard("card-1", "最终回答", 3, "completed");

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: "/open-apis/cardkit/v1/cards/card-1",
    }));
    const payload = request.mock.calls[0]?.[0] as { data: { card: { data: string }; sequence: number } };
    expect(payload.data.sequence).toBe(3);
    const card = JSON.parse(payload.data.card.data) as Record<string, unknown>;
    const json = JSON.stringify(card);
    expect(json).toContain("已完成");
    expect(json).not.toContain("run.stop");
    expect(json).not.toContain("session.select");
  });

  it("removes crash-leftover payloads only from a dedicated attachments directory", async () => {
    const parent = mkdtempSync(join(tmpdir(), "xiaowang-attachment-reset-"));
    const root = join(parent, "attachments");
    mkdirSync(join(root, "stale"), { recursive: true });
    writeFileSync(join(root, "stale", "payload"), "secret");

    await resetAttachmentRoot(root);

    expect(readdirSync(root)).toEqual([]);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    await expect(resetAttachmentRoot(parent)).rejects.toThrow("refusing to reset");
  });

  it("writes a server-owned 0600 image and removes its private directory on cleanup", async () => {
    const { adapter } = fixture(
      Buffer.from("image-bytes"),
      { "content-type": "image/png", "content-length": "11" },
    );

    const downloaded = await adapter.downloadAttachment("om_safe", {
      kind: "image",
      fileKey: "img_v3_safe",
    });

    expect(downloaded.path).toMatch(/resource\.png$/);
    expect(readFileSync(downloaded.path, "utf8")).toBe("image-bytes");
    expect(statSync(downloaded.path).mode & 0o777).toBe(0o600);
    const directory = dirname(downloaded.path);
    await downloaded.cleanup();
    expect(existsSync(directory)).toBe(false);
  });

  it("rejects unsafe keys and oversized resources without leaving a payload behind", async () => {
    const { adapter, root, get } = fixture(
      Buffer.from("four"),
      { "content-type": "application/pdf", "content-length": "4" },
      3,
    );

    await expect(adapter.downloadAttachment("om_safe", {
      kind: "file",
      fileKey: "../../unsafe",
      displayName: "report.pdf",
    })).rejects.toThrow("invalid Feishu attachment key");
    expect(get).not.toHaveBeenCalled();

    await expect(adapter.downloadAttachment("om_safe", {
      kind: "file",
      fileKey: "file_v3_safe",
      displayName: "report.pdf",
    })).rejects.toThrow("gateway size limit");
    expect(readdirSync(root)).toEqual([]);
  });
});
