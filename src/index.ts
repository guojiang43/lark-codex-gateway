import { dirname, join } from "node:path";

import { AppServerClient } from "./codex/app-server-client.js";
import {
  AppServerCodexRuntime,
} from "./codex/codex-runtime.js";
import { ManagedCodexRuntime } from "./codex/managed-codex-runtime.js";
import {
  buildRemoteCodexProxyArgs,
  buildRemoteCodexStdioArgs,
  refreshRemoteCodexThread,
} from "./codex/desktop-thread-presenter.js";
import {
  HostRoutingCodexRuntime,
  encodeExecutionThreadId,
  type HostDefinition,
} from "./codex/host-routing-runtime.js";
import { loadConfig } from "./config.js";
import { FeishuAdapter, resetAttachmentRoot } from "./feishu/feishu-adapter.js";
import { FeishuIngress } from "./feishu/feishu-ingress.js";
import { GatewayService } from "./gateway/gateway-service.js";
import { ProjectQueue } from "./queue/project-queue.js";
import { StateStore } from "./state/state-store.js";
import { SessionController } from "./session/session-controller.js";
import { ApprovalController } from "./approval/approval-controller.js";
import { recoverStartupState } from "./recovery/startup-recovery.js";
import { verifyCodexContract } from "./codex/contract-check.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new StateStore(config.statePath);
  store.upsertProject({
    projectId: config.project.projectId,
    displayName: config.project.displayName,
    workspacePath: config.project.workspacePath,
    hostId: config.hostId,
  });
  const attachmentRoot = join(dirname(config.statePath), "attachments");
  await resetAttachmentRoot(attachmentRoot);
  const feishu = new FeishuAdapter({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    attachmentRoot,
  });
  const recovery = await recoverStartupState({ store, feishu, now: Date.now() });
  if (recovery.staleRunCount > 0 || recovery.expiredApprovalCount > 0 || recovery.errors.length > 0) {
    process.stderr.write(`${JSON.stringify({ level: "warn", event: "startup_recovery", ...recovery })}\n`);
  }
  const approvals = new ApprovalController({
    store,
    feishu,
    workspacePath: config.project.workspacePath,
    ...(config.macbookWorker
      ? { additionalWorkspacePaths: [config.macbookWorker.workspacePath] }
      : {}),
    allowedSenderId: config.allowedSenderId,
    onError: (error) => process.stderr.write(
      `${JSON.stringify({ level: "error", event: "approval_failed", message: error.message })}\n`,
    ),
  });
  const m4Runtime = new ManagedCodexRuntime({
    displayName: "Gateway Mac",
    connect: async () => {
      await verifyCodexContract(config.codexBin);
      return await connectAppServer({
        command: config.codexBin,
        hostId: "m4",
        approvals,
      });
    },
    onError: (error) => logRuntimeError("m4", error),
  });
  const managedRuntimes = [m4Runtime];
  const hosts: HostDefinition[] = [{
    hostId: "m4",
    displayName: "Gateway Mac",
    workspacePath: config.project.workspacePath,
    runtime: m4Runtime,
    status: () => ({ available: m4Runtime.available, detail: m4Runtime.detail }),
  }];
  if (config.macbookWorker) {
    const worker = config.macbookWorker;
    const macbookRuntime = new ManagedCodexRuntime({
      displayName: "Worker Mac",
      connect: async () => {
        const remoteInput = {
          sshUser: worker.sshUser,
          sshHost: worker.sshHost,
          sshPort: worker.sshPort,
          codexBin: worker.codexBin,
        };
        try {
          return await connectAppServer({
            command: "/usr/bin/ssh",
            args: buildRemoteCodexProxyArgs(remoteInput),
            transport: "websocket",
            hostId: "macbook",
            approvals,
          });
        } catch (error) {
          process.stderr.write(`${JSON.stringify({
            level: "warn",
            event: "macbook_desktop_proxy_unavailable",
            message: error instanceof Error ? error.message : String(error),
            fallback: "standalone_stdio_with_desktop_refresh",
          })}\n`);
          return await connectAppServer({
            command: "/usr/bin/ssh",
            args: buildRemoteCodexStdioArgs(remoteInput),
            hostId: "macbook",
            approvals,
          });
        }
      },
      onError: (error) => logRuntimeError("macbook", error),
    });
    managedRuntimes.push(macbookRuntime);
    hosts.push({
      hostId: "macbook",
      displayName: "Worker Mac",
      workspacePath: worker.workspacePath,
      runtime: macbookRuntime,
      status: () => ({ available: macbookRuntime.available, detail: macbookRuntime.detail }),
      refreshThread: (threadId: string) => refreshRemoteCodexThread({
        sshUser: worker.sshUser,
        sshHost: worker.sshHost,
        sshPort: worker.sshPort,
        threadId,
      }),
    });
  }
  await Promise.all(managedRuntimes.map((runtime) => runtime.start()));
  const codex = new HostRoutingCodexRuntime({
    defaultHostId: "m4",
    hosts,
    onRefreshError: ({ hostId, threadId, error }) => process.stderr.write(`${JSON.stringify({
      level: "warn",
      event: "desktop_thread_refresh_failed",
      hostId,
      threadId,
      message: error.message,
    })}\n`),
  });
  const queue = new ProjectQueue();
  const gateway = new GatewayService({
    store,
    queue,
    feishu,
    codex,
    executionHosts: codex,
    approvals,
    projectId: config.project.projectId,
    projectDisplayName: config.project.displayName,
    workspacePath: config.project.workspacePath,
    allowedSenderId: config.allowedSenderId,
    onError: (error) => process.stderr.write(
      `${JSON.stringify({ level: "error", event: "gateway_run_failed", message: error.message })}\n`,
    ),
  });
  const sessions = new SessionController({
    store,
    feishu,
    codex,
    queue,
    approvals,
    projectId: config.project.projectId,
    projectDisplayName: config.project.displayName,
    workspacePath: config.project.workspacePath,
    allowedSenderId: config.allowedSenderId,
    codexStatus: () => codex.listHosts()
      .map((host) => `${host.displayName}：${host.available ? "已连接" : host.detail}`)
      .join("；"),
    executionHosts: codex,
    onError: (error) => process.stderr.write(
      `${JSON.stringify({ level: "error", event: "session_action_failed", message: error.message })}\n`,
    ),
  });
  const ingress = new FeishuIngress({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    gateway,
    sessions,
    approvals,
    onReady: () => process.stderr.write(`${JSON.stringify({ level: "info", event: "feishu_ws_ready" })}\n`),
    onError: (error) => process.stderr.write(`${JSON.stringify({ level: "error", event: "feishu_ws_error", message: error.message })}\n`),
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`${JSON.stringify({ level: "info", event: "shutdown", signal })}\n`);
    ingress.close();
    await Promise.all(managedRuntimes.map((runtime) => runtime.stop()));
    store.close();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));

  await ingress.start();
}

async function connectAppServer(input: {
  command: string;
  args?: string[];
  transport?: "stdio" | "websocket";
  hostId: string;
  approvals: ApprovalController;
}) {
  const client = new AppServerClient({
    command: input.command,
    ...(input.args ? { args: input.args } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    approvalTimeoutMs: 135_000,
    decideApproval: (request) => input.approvals.requestDecision({
      ...request,
      params: {
        ...request.params,
        ...(typeof request.params.threadId === "string"
          ? { threadId: encodeExecutionThreadId(input.hostId, request.params.threadId) }
          : {}),
      },
    }),
  });
  try {
    await client.initialize();
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return {
    runtime: new AppServerCodexRuntime(client),
    close: () => client.close(),
    onExit: (listener: (event: { code: number | null; signal: NodeJS.Signals | null }) => void) => {
      client.once("exit", listener);
    },
  };
}

function logRuntimeError(hostId: string, error: Error): void {
  process.stderr.write(`${JSON.stringify({
    level: "error",
    event: "codex_host_unavailable",
    hostId,
    message: error.message,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ level: "fatal", event: "startup_failed", message })}\n`);
  process.exitCode = 1;
});
