# Lark Codex Gateway

[![CI](https://github.com/guojiang43/lark-codex-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/guojiang43/lark-codex-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

把飞书/Lark 私聊机器人连接到 macOS 上的本地 Codex session。网关提供事件鉴权、消息幂等、串行队列、审批卡片、Card 2.0 流式输出、session 管理、SQLite 恢复，以及可选的双 Mac 执行架构。

> 当前实现面向 macOS。项目使用 Codex app-server 接口，其中部分 Desktop 实时同步能力依赖未公开保证稳定的本地 daemon 行为；升级 Codex 后应重新执行真实验收。

## 架构

单设备模式：

```text
Feishu/Lark <-> gateway + Codex app-server + workspace
```

双设备模式：

```text
Feishu/Lark <-> always-on gateway Mac <-> reverse SSH <-> worker Mac + Codex Desktop
```

双设备模式下，飞书长连接只运行在网关 Mac。worker 休眠不会让机器人入口离线；任务不会在 worker 离线时静默切换到另一台机器。

## 主要能力

- 仅接受配置的 `open_id` 发来的 P2P 消息；
- 一个 project 内的可写任务串行，停止请求直达 Codex interrupt；
- 同卡流式更新，结束后移除运行期按钮和中间 commentary；
- 新建、切换、查看、重命名、归档 session；
- 一次性命令/文件/权限审批，超时拒绝且回调幂等；
- 图片和文件受控下载，任务结束后清理临时文件；
- SQLite WAL 状态和安全启动恢复，不自动重放未完成任务；
- app-server 不可用时保持飞书入口在线并明确降级，不伪造执行结果。

## 安全边界

- App Secret 优先存储在 macOS 登录钥匙串；无法访问钥匙串时，只回退到权限为 `0600` 的本机配置文件；
- Secret、token、私钥、Codex 认证状态、SQLite 与日志均不得提交到 Git；
- project 路径由服务端固定，飞书消息不能指定任意本地路径；
- 审批只支持“允许一次/拒绝”，project 外写入直接拒绝；
- worker sshd 和反向端口只绑定 `127.0.0.1`，禁用密码、TTY 和端口转发；
- 同一个飞书应用只能有一个活动网关消费者。

## 环境要求

- macOS；
- Node.js `>=22.19`；
- 已登录的 Codex CLI 或 Codex Desktop；
- 飞书/Lark 企业自建应用；
- 双设备模式另需两台 Mac 之间已有可用的 SSH 主机别名。

## 飞书后台

启用机器人能力，并使用长连接配置：

- 权限：`im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:message.reactions:write_only`、`cardkit:card:write`；
- 附件模式另需 `im:message:readonly`；
- 事件：`im.message.receive_v1`、`application.bot.menu_v6`；
- 回调：`card.action.trigger`。

后台菜单事件 key、发布和验收步骤见 [飞书后台配置清单](docs/feishu-backend-checklist.md)。保存配置后必须创建并发布应用版本。

## 安装

```bash
git clone https://github.com/guojiang43/lark-codex-gateway.git
cd lark-codex-gateway
npm ci
npm test
npm run typecheck
npm run build
```

先在网关 Mac 的交互式终端写入 App Secret，输入不会回显：

```bash
./scripts/setup-keychain-secret.zsh 'cli_YOUR_APP_ID'
```

### 单设备

```bash
./scripts/install-launch-agent.zsh \
  '/absolute/path/to/workspace' \
  'stable-project-id' \
  'Project Display Name' \
  'ou_ALLOWED_USER_ID'
```

### 双设备

先在 worker Mac 安装回环 sshd 和到网关 Mac 的反向隧道：

```bash
./scripts/install-macbook-worker-tunnel.zsh \
  '/path/to/gateway-dedicated-public-key' \
  'gateway-ssh-alias'
```

再在网关 Mac 安装常驻服务，并传入 worker 上的工作区和 SSH 用户名：

```bash
./scripts/install-launch-agent.zsh \
  '/absolute/path/on/gateway' \
  'stable-project-id' \
  'Project Display Name' \
  'ou_ALLOWED_USER_ID' \
  '/absolute/path/on/worker' \
  'worker_user'
```

安装脚本把非 Secret 配置写入 `~/.config/lark-codex-gateway` 的 `0600` 文件，基于当前 checkout 生成 LaunchAgent，并拒绝与前台网关进程并存。卸载不会删除数据库、日志或钥匙串项：

```bash
./scripts/uninstall-launch-agent.zsh
```

## Session 可见性

网关按目标 workspace 的绝对 `cwd` 从 Codex `thread/list` 同步 session。thread ID 归属于执行主机；两台 Mac 的本地 session 不会被伪装成同一个 session。跨机器继续工作应同步 project 文件并做显式 handoff，不应复制整个 `~/.codex`。

Codex Desktop 是否立即显示外部 turn，取决于 Desktop 与网关是否连接同一个 managed app-server daemon。完整的单/双机部署、验证和回滚流程见 [Agent Deployment Runbook](docs/agent-deployment-runbook.md)。

## 开发与验证

```bash
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

不要使用真实用户消息、真实 App ID/open_id、绝对个人路径或生产数据库作为测试夹具。

## 贡献与安全

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请不要创建公开 issue，按 [SECURITY.md](SECURITY.md) 使用 GitHub Security Advisory 私下报告。

## License

[MIT](LICENSE)
