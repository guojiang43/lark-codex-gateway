import { describe, expect, it } from "vitest";

import { healthCard } from "../src/session/session-cards.js";

describe("session cards", () => {
  it("keeps every CardKit element_id inside Feishu's format and 20-character limit", () => {
    const card = healthCard({
      projectName: "Example Project",
      queueBusy: false,
      sessionCount: 11,
      uptimeMs: 1_000,
      codexStatus: "M4：已连接；MacBook：已连接",
      gatewayHostName: "M4",
      currentExecutionHostId: "m4",
      executionHosts: [
        { hostId: "m4", displayName: "M4", available: true, detail: "已连接" },
        { hostId: "macbook", displayName: "MacBook", available: true, detail: "已连接" },
      ],
    });

    for (const elementId of collectElementIds(card)) {
      expect(elementId, elementId).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,19}$/);
    }
    const cardJson = JSON.stringify(card);
    expect(cardJson).toContain("Codex");
    expect(cardJson).not.toContain("小王");
  });
});

function collectElementIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectElementIds);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.element_id === "string" ? [record.element_id] : []),
    ...Object.values(record).flatMap(collectElementIds),
  ];
}
