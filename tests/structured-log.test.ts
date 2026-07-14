import { describe, expect, it } from "vitest";

import { formatStructuredLog } from "../src/structured-log.js";

describe("formatStructuredLog", () => {
  it("adds an ISO timestamp to every JSON log record", () => {
    const line = formatStructuredLog(
      { level: "info", event: "feishu_ws_ready" },
      new Date("2026-07-14T06:30:00.123Z"),
    );

    expect(JSON.parse(line)).toEqual({
      level: "info",
      event: "feishu_ws_ready",
      ts: "2026-07-14T06:30:00.123Z",
    });
    expect(line.endsWith("\n")).toBe(true);
  });
});
