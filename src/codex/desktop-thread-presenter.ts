import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RemoteCodexThreadInput {
  sshUser: string;
  sshHost: string;
  sshPort: number;
  threadId: string;
}

export interface RemoteCodexProxyInput {
  sshUser: string;
  sshHost: string;
  sshPort: number;
  codexBin: string;
}

export function buildRemoteCodexProxyArgs(input: RemoteCodexProxyInput): string[] {
  return [...remoteSshPrefix(input), input.codexBin, "app-server", "proxy"];
}

export function buildRemoteCodexStdioArgs(input: RemoteCodexProxyInput): string[] {
  return [...remoteSshPrefix(input), input.codexBin, "app-server", "--stdio"];
}

function remoteSshPrefix(input: RemoteCodexProxyInput): string[] {
  return [
    "-p", String(input.sshPort),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=yes",
    `${input.sshUser}@${input.sshHost}`,
  ];
}

export function buildRemoteCodexThreadOpenArgs(input: RemoteCodexThreadInput): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(input.threadId)) {
    throw new Error("invalid Codex thread id");
  }
  return [
    "-p", String(input.sshPort),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes",
    `${input.sshUser}@${input.sshHost}`,
    "/usr/bin/open",
    "-g",
    `codex://threads/${input.threadId}`,
  ];
}

export async function refreshRemoteCodexThread(input: RemoteCodexThreadInput): Promise<void> {
  await execFileAsync("/usr/bin/ssh", buildRemoteCodexThreadOpenArgs(input), {
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
}
