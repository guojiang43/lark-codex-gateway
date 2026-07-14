import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REQUIRED_CLIENT_METHODS = [
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/list",
  "turn/start",
  "turn/interrupt",
];
const REQUIRED_SERVER_REQUESTS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
];
const REQUIRED_SERVER_NOTIFICATIONS = [
  "item/agentMessage/delta",
  "turn/completed",
];

export function assertCodexContract(input: {
  clientSchema: string;
  serverRequestSchema: string;
  serverNotificationSchema: string;
}): void {
  assertContains(input.clientSchema, REQUIRED_CLIENT_METHODS, "client request");
  assertContains(input.serverRequestSchema, REQUIRED_SERVER_REQUESTS, "server request");
  assertContains(input.serverNotificationSchema, REQUIRED_SERVER_NOTIFICATIONS, "server notification");
}

export async function verifyCodexContract(codexBin: string): Promise<void> {
  const outputDir = await mkdtemp(join(tmpdir(), "xiaowang-codex-contract-"));
  try {
    await execFileAsync(
      codexBin,
      ["app-server", "generate-json-schema", "--experimental", "--out", outputDir],
      { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const [clientSchema, serverRequestSchema, serverNotificationSchema] = await Promise.all([
      readFile(join(outputDir, "ClientRequest.json"), "utf8"),
      readFile(join(outputDir, "ServerRequest.json"), "utf8"),
      readFile(join(outputDir, "ServerNotification.json"), "utf8"),
    ]);
    assertCodexContract({ clientSchema, serverRequestSchema, serverNotificationSchema });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

function assertContains(schema: string, methods: string[], kind: string): void {
  for (const method of methods) {
    if (!schema.includes(`\"${method}\"`)) {
      throw new Error(`Codex app-server contract is missing ${kind} method: ${method}`);
    }
  }
}
