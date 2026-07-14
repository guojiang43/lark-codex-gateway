import { describe, expect, it } from "vitest";

import { buildAnswerCard, buildFinalAnswerCard } from "../src/feishu/feishu-adapter.js";

describe("buildAnswerCard", () => {
  it("uses Card 2.0 streaming markdown with only the run-time stop control", () => {
    const json = JSON.stringify(buildAnswerCard());

    expect(json).toContain('"schema":"2.0"');
    expect(json).toContain('"streaming_mode":true');
    expect(json).toContain('"element_id":"answer"');
    expect(json).toContain('"action":"run.stop"');
    expect(json).not.toContain('"action":"session.select"');
  });

  it("renders a final status card without stale run or session controls", () => {
    const json = JSON.stringify(buildFinalAnswerCard("收到，测试正常。", "completed"));

    expect(json).toContain('"streaming_mode":false');
    expect(json).toContain("已完成");
    expect(json).toContain("收到，测试正常。");
    expect(json).not.toContain('"action":"run.stop"');
    expect(json).not.toContain('"action":"session.select"');
  });
});
