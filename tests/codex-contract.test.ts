import { describe, expect, it } from "vitest";

import { assertCodexContract } from "../src/codex/contract-check.js";

const clientMethods = ["thread/start", "thread/resume", "thread/fork", "thread/list", "turn/start", "turn/interrupt"];
const serverRequests = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
];
const serverNotifications = ["item/agentMessage/delta", "turn/completed"];

describe("assertCodexContract", () => {
  it("accepts the exact protocol surface required by the gateway", () => {
    expect(() => assertCodexContract({
      clientSchema: JSON.stringify(clientMethods),
      serverRequestSchema: JSON.stringify(serverRequests),
      serverNotificationSchema: JSON.stringify(serverNotifications),
    })).not.toThrow();
  });

  it("refuses startup when a required protocol method disappears", () => {
    expect(() => assertCodexContract({
      clientSchema: JSON.stringify(clientMethods.filter((method) => method !== "thread/fork")),
      serverRequestSchema: JSON.stringify(serverRequests),
      serverNotificationSchema: JSON.stringify(serverNotifications),
    })).toThrow("thread/fork");
  });
});
