# Lark Codex Gateway Agent Instructions

When asked to deploy, migrate, upgrade, diagnose, or hand off this gateway:

1. Read `docs/agent-deployment-runbook.md` completely.
2. Create a deployment manifest from `docs/agent-deployment-manifest.example.yaml`; never put a secret or access token in it.
3. Follow root-cause-first, test-first engineering discipline: reproduce failures, make narrow changes, and verify the real runtime before claiming success.
4. Inspect runtime truth before changing files or services. Start with `git status --short --branch`, current processes, LaunchAgents, Codex daemon status, and active SQLite runs.
5. Do not read, print, copy, or log App Secret, access tokens, Codex auth state, private keys, or Keychain values. Secret entry is a user-interactive gate.
6. Never run two Feishu event consumers for one app. Stop and request direction if another gateway instance is active and ownership is unclear.
7. Do not restart Codex Desktop, reboot a Mac, publish a Feishu app version, or restart a gateway with an active run without explicit authority.
8. Behavior changes require a failing test or minimal reproduction before the narrow fix. Run the full verification suite before deployment.
9. Do not claim success until a real Feishu message appears in the intended Codex Desktop task without another restart.

Required verification:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

Required final report:

- deployment mode and actual hosts;
- files changed;
- Feishu backend status;
- service/process/daemon status;
- verification commands and results;
- real Feishu acceptance evidence;
- residual risks and rollback commands.
