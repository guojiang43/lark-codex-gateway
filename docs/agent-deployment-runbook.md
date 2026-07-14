# Agent Deployment Runbook

This is the execution entrypoint for an AI agent deploying the Feishu × Codex gateway. The human architecture and Feishu menu reference are in `README.md` and `docs/feishu-backend-checklist.md`.

The objective is not “start a process.” The objective is a verified chain:

```text
real Feishu message
  -> exactly one gateway
  -> intended execution host and workspace
  -> intended Codex thread
  -> streaming Feishu card
  -> same turn visible in Codex Desktop without another restart
```

## 1. Execution contract

The deployment agent must:

- follow root-cause-first, test-first engineering discipline;
- read this runbook completely before changing state;
- use `docs/agent-deployment-manifest.example.yaml` to collect inputs;
- keep secrets out of prompts, files, terminal output, logs, patches, and final reports;
- preserve unrelated worktree changes;
- prove runtime state instead of inferring it from source files;
- implement behavior changes test-first;
- install and restart only within explicit authorization in the manifest;
- stop at user/admin gates rather than pretending they succeeded;
- leave a reproducible handoff if interrupted.

## 2. Non-negotiable invariants

1. One Feishu app has exactly one active event consumer.
2. The gateway host owns the authoritative SQLite state.
3. A thread ID is scoped to its execution host.
4. Worker Mac sleep must not take down the Feishu entrypoint in dual mode.
5. Desktop realtime visibility requires Desktop and worker to share one managed app-server daemon.
6. No active run may be restarted or replayed automatically.
7. App Secret is entered by the user through a non-echoing local prompt.
8. The worker control socket is not exposed to the public network.

## 3. Mandatory inputs

Create a private manifest from the example. It may contain App ID and open_id, but never App Secret, tokens, passwords, or private keys.

The agent must resolve these before deployment:

- `single` or `dual` mode;
- gateway repo and workspace absolute paths;
- stable project ID and display name;
- Feishu App ID and allowed user open_id;
- whether the Feishu backend version is already published;
- whether Desktop realtime visibility is required;
- Codex binary path on every execution host;
- dual mode SSH aliases, usernames, workspace paths, and reverse port;
- permission to install dependencies, standalone Codex, LaunchAgents, restart services, restart Desktop, and publish Feishu changes.

If a missing value changes architecture or causes an external write, ask for it. Do not invent it.

## 4. Stop conditions

Stop and report the exact blocker when:

- the worktree has overlapping unknown changes;
- another Feishu gateway is active and ownership cannot be established;
- an App Secret would need to be read or printed by the agent;
- the user has not authorized a LaunchAgent install, service restart, Desktop restart, or Feishu publish action;
- an active run exists during a planned restart;
- the Feishu admin/backend gate is incomplete;
- Codex CLI and app-server versions are incompatible;
- single mode requires realtime Desktop sync but the local-proxy configuration is not implemented;
- the standard tests or build fail;
- a real Feishu acceptance test cannot be performed.

Do not label the whole deployment “blocked” merely because one user gate is pending. Complete all safe preparation first, then provide the smallest next action.

## 5. Phase 0 — classify and inspect

Record the deployment as one of:

- fresh single-device deployment;
- fresh dual-device deployment;
- migration from another gateway host;
- upgrade of an existing deployment;
- production incident recovery.

On each local repo:

```bash
git status --short --branch
node --version
npm --version
rg -n 'cli_|ou_|/Users/' scripts src deploy .env.example README.md
```

Inspect services without exposing environments or secrets:

```bash
launchctl list | grep -i lark-codex || true
ps -axo pid,ppid,etime,command | grep -E 'dist/src/index.js|app-server proxy|app-server --stdio' | grep -v grep || true
codex app-server daemon version || true
```

If an existing SQLite database is present, inspect schema first and then active runs using the real column names:

```bash
sqlite3 .data/gateway.db '.schema runs'
sqlite3 -header -column .data/gateway.db \
  "select run_id,state,turn_id,created_at,updated_at from runs where state in ('QUEUED','RUNNING','WAITING_APPROVAL');"
```

Never guess a database column from an older deployment.

## 6. Phase 1 — Feishu backend gate

If the agent has a signed-in browser session and explicit permission to modify the application, it may configure the backend. Otherwise produce this exact checklist for the user/admin and wait for confirmation.

### Required capabilities and permissions

- enterprise custom app;
- bot capability enabled;
- `im:message.p2p_msg:readonly`;
- `im:message:send_as_bot`;
- `im:message.reactions:write_only`;
- `im:message:readonly` when attachments are enabled;
- `cardkit:card:write`.

Optional group @ support:

```text
im:message.group_at_msg:readonly
```

### Required event configuration

Use long connection:

- `im.message.receive_v1`;
- `application.bot.menu_v6`.

Use long-connection callback:

- `card.action.trigger`.

### Required menu event keys

```text
new_session
session_select
session_current
session_rename
session_archive
current_status
stop_generation
help
```

Each menu action must be “push event.” The target user must be in the app availability scope. A new app version must be created and published.

The agent must not claim the backend is ready from a saved draft. Evidence is a published version plus a real menu/message event.

## 7. Phase 2 — portability gate

The public repository is deployment-neutral. Before every deployment, confirm that no real operator identity has been copied back into tracked files. Do not replace placeholders with one person's literals; pass them through the installer and protected local configuration.

Audit at minimum:

- `scripts/run-gateway.zsh`;
- `scripts/setup-keychain-secret.zsh`;
- `src/config.ts` defaults;
- LaunchAgent labels and templates;
- `.env.example` and README examples.

Preferred design:

- non-secret settings live in `0600` files under `~/.config/lark-codex-gateway` or validated environment variables;
- App Secret lives in Keychain or a `0600` fallback file;
- installation scripts accept App ID, allowed open_id, project name, usernames, and paths as arguments or protected config inputs;
- generated plist files contain no App Secret;
- defaults are neutral and never reference a real user.

For behavior changes, first add a failing test that proves the old hardcoded behavior, then implement the narrow parameterization. Re-run the personal-data scan until executable files contain no old deployment identity.

## 8. Phase 3 — build gate

Run the standard path, not an approximate substitute:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

All commands must exit 0. Read test counts and audit output. Do not continue to production with a failed test or build.

## 9. Phase 4 — secret gate

The user enters App Secret locally with echo disabled:

```bash
./scripts/setup-keychain-secret.zsh 'cli_YOUR_APP_ID'
```

Agent rules:

- never ask the user to paste App Secret into chat;
- never run `security ... -w` and print the value;
- never copy the Secret between hosts through chat, logs, Git, rsync, or SCP;
- verify only existence, ownership, permission, and command exit code;
- in dual mode, only the unique gateway host needs the Feishu App Secret.

If interactive entry is not possible, stop at this gate and give the user the exact local command.

## 10. Phase 5 — Codex managed daemon

When authorized, install official standalone Codex:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
```

Verify login without printing auth state, then bootstrap:

```bash
~/.local/bin/codex --version
~/.local/bin/codex app-server daemon bootstrap
~/.local/bin/codex app-server daemon version
```

Required daemon evidence:

- `status` is `running`;
- `managedCodexVersion`, `cliVersion`, and `appServerVersion` are compatible;
- `socketPath` exists under `~/.codex/app-server-control`.

The proxy transport is WebSocket framing over the command byte stream:

```bash
codex app-server proxy
```

It is not JSONL stdio. The gateway must use `transport: "websocket"` for proxy and retain stdio only as an explicit fallback.

## 11. Phase 6A — single-device branch

### Without Desktop realtime requirement

The current local stdio runtime can be deployed after parameterization:

```bash
./scripts/install-launch-agent.zsh \
  '<absolute-workspace-path>' \
  '<stable-project-id>' \
  '<project-display-name>' \
  '<allowed-user-open-id>'
```

This provides Feishu execution and persistent threads, but a running Desktop may not see external turns until it reloads.

### With Desktop realtime requirement

Current packaging does not expose the local daemon proxy as a configuration flag. The agent must not claim this mode works out of the box.

Implement it test-first:

1. add a config flag such as `XIAOWANG_LOCAL_DAEMON=1`;
2. add a failing test proving that enabled mode selects `CODEX_BIN app-server proxy` with WebSocket transport;
3. keep disabled mode on existing stdio;
4. make proxy connection failure fall back explicitly without hiding the downgrade;
5. run full verification;
6. start managed daemon;
7. configure Desktop to use the same daemon;
8. perform a real Feishu-to-Desktop test.

The already implemented `AppServerClient` WebSocket transport is the primitive to reuse. Do not create a second protocol implementation.

## 12. Phase 6B — dual-device branch

### Worker host

Install standalone Codex and managed daemon first. Create or receive only the gateway host's dedicated public key, then run:

```bash
./scripts/install-macbook-worker-tunnel.zsh \
  '<path-to-gateway-public-key>' \
  '<gateway-ssh-alias>'
```

Verify both worker LaunchAgents and confirm the worker sshd listens only on `127.0.0.1:19022`.

### Gateway host

Before install, find and stop any previous gateway consumer after confirming there is no active run. Then:

```bash
./scripts/install-launch-agent.zsh \
  '<gateway-workspace-path>' \
  '<stable-project-id>' \
  '<project-display-name>' \
  '<allowed-user-open-id>' \
  '<worker-workspace-path>' \
  '<worker-ssh-user>'
```

The expected worker process on the gateway host is conceptually:

```text
ssh -p 19022 <worker-user>@127.0.0.1 <worker-codex> app-server proxy
```

Required evidence:

- one gateway LaunchAgent is running;
- one Feishu WebSocket consumer exists;
- gateway log contains `feishu_ws_ready`;
- worker proxy SSH process remains alive;
- worker daemon socket has both Desktop and proxy clients;
- disconnecting the worker does not terminate the gateway process.

## 13. Phase 7 — Desktop shared-control gate

The currently verified Desktop build reads this internal variable at startup:

```bash
launchctl setenv CODEX_APP_SERVER_USE_LOCAL_DAEMON 1
```

Persist it with a user LaunchAgent that runs the same command at login. Do not put secrets in that plist.

This variable is not a documented stable Codex setting. The agent must:

1. state the compatibility risk;
2. obtain permission before installing the LaunchAgent;
3. obtain permission before asking the user to restart Desktop;
4. never force-close Desktop during an active task;
5. verify after restart that no Desktop-owned `app-server --stdio` exists;
6. use `lsof -U` to prove Desktop and proxy connect to the managed socket.

If the flag stops working after an upgrade, keep the bot functional through fallback and report Desktop realtime as degraded.

## 14. Phase 8 — safe service activation

Before any gateway restart:

1. query active runs;
2. wait for completion or obtain explicit cancellation approval;
3. confirm no second consumer is running;
4. record current PID and last exit code;
5. restart with `launchctl kickstart -k`;
6. record new PID and readiness log;
7. verify no new downgrade or fatal error.

Do not reboot a Mac to prove persistence unless the user explicitly approves a reboot window.

## 15. Phase 9 — real acceptance

Unit tests are necessary but insufficient. Use a real P2P Feishu message with a unique, non-sensitive nonce.

Verify in order:

1. inbound event is persisted once;
2. one run is created;
3. run binds to the intended host-scoped session;
4. `turn_id` is populated;
5. reaction appears and is removed;
6. one Card 2.0 message streams with correct paragraph separation;
7. final card removes runtime buttons and commentary;
8. run becomes `COMPLETED` without `error_code`;
9. the same user message and answer appear in the intended Desktop task without another restart;
10. `codex_thread_id` equals the intended Desktop thread.

For dual mode also test worker disconnect:

- gateway remains running;
- Feishu menu still responds;
- worker is shown offline;
- no silent replay occurs on the gateway host;
- user can explicitly switch execution host.

Do not call deployment complete before the user confirms the Desktop UI evidence.

## 16. Rollback

Rollback should preserve SQLite, logs, threads, and workspaces.

Gateway:

```bash
launchctl bootout gui/$(id -u)/<gateway-label>
```

Desktop daemon preference:

```bash
launchctl unsetenv CODEX_APP_SERVER_USE_LOCAL_DAEMON
launchctl bootout gui/$(id -u)/<desktop-daemon-env-label>
```

Managed daemon, only when no client needs it:

```bash
codex app-server daemon stop
```

Never delete `.data/gateway.db`, Keychain items, `~/.codex`, SSH keys, or rollout files as part of a routine rollback.

## 17. Required handoff

The deployment agent's final report must contain:

```text
Conclusion: complete | partial | blocked
Mode: single | dual
Gateway host:
Worker host:
Feishu published version status:
Files changed:
Services installed or changed:
Verification commands and actual results:
Real Feishu event/run/turn/thread evidence:
Desktop realtime evidence:
Residual risks:
Rollback commands:
Next user action:
```

Never include App Secret, tokens, private keys, raw auth state, or full private message content.

## 18. Copy-paste prompt for the colleague's agent

Replace the placeholders and attach the repository:

```text
请在 <gateway-repository-path> 部署飞书 × Codex 本地网关。

请遵守根因优先、测试优先的工程纪律：先复现，做最小改动，完成真实运行时验证后再声明成功。

先完整阅读：
1. AGENTS.md
2. docs/agent-deployment-runbook.md
3. docs/agent-deployment-manifest.example.yaml
4. docs/feishu-backend-checklist.md

部署模式：<single 或 dual>
目标：<是否要求飞书消息无需重启实时出现在 Codex Desktop>

请先创建不含任何 Secret/token/私钥的私有 deployment manifest，列出缺失输入和需要我授权的外部写操作。不要读取或输出 App Secret，不要读取现有 token，不要回滚无关改动。

按 runbook 的 phase 顺序推进：运行时盘点 → 飞书后台 gate → 参数化 → 全量测试 → 用户交互写入 Secret → managed daemon → 单/双机部署 → 安全重启 → 真实飞书验收。

同一个飞书应用只能有一个网关消费者。存在活动 run 时不得重启。未经我明确同意，不得发布飞书版本、安装 LaunchAgent、重启 Codex Desktop 或重启电脑。

完成标准不是进程启动，而是：真实飞书消息只产生一个 run，进入指定 host/thread，流式卡片正确结束，并且无需再次重启就实时出现在指定 Codex Desktop task。

最终报告必须包含：改动文件、服务状态、验证命令与结果、真实 event/run/turn/thread 证据、剩余风险和回滚命令。
```
