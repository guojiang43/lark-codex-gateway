import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DISPLAY_NAME_M4,
  DISPLAY_NAME_MACBOOK,
  HOST_ID_M4,
  HOST_ID_MACBOOK,
} from "../src/codex/host-constants.js";

describe("execution host labels", () => {
  it("keeps routing identifiers separate from user-facing app-server names", () => {
    expect({
      m4: { hostId: HOST_ID_M4, displayName: DISPLAY_NAME_M4 },
      macbook: { hostId: HOST_ID_MACBOOK, displayName: DISPLAY_NAME_MACBOOK },
    }).toEqual({
      m4: { hostId: "m4", displayName: "M4mini" },
      macbook: { hostId: "macbook", displayName: "MacBook" },
    });
  });

  it("uses the shared labels in runtime composition and the health card", () => {
    const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const controllerSource = readFileSync(
      new URL("../src/session/session-controller.ts", import.meta.url),
      "utf8",
    );

    expect(indexSource).toContain("displayName: DISPLAY_NAME_M4");
    expect(indexSource).toContain("displayName: DISPLAY_NAME_MACBOOK");
    expect(indexSource).not.toContain('displayName: "Gateway Mac"');
    expect(indexSource).not.toContain('displayName: "Worker Mac"');
    expect(controllerSource).toContain("gatewayHostName: DISPLAY_NAME_M4");
  });
});
