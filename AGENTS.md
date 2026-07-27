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

<!-- BEGIN JOHN PRIMARY MEMORY SOURCE -->
## John Primary Memory Source

This machine uses a primary local memory source for all John projects. This project should use that source, not grow an isolated memory.

## Memory Roles

- `AGENTS.md` contains required behavior and routing rules.
- Native Codex memory under `~/.codex/memories` is a generated local recall layer. Treat it as helpful orientation, not as the portable source of truth.
- `/Users/johngoal/Documents/公园日常工作/memory` is John's reviewed primary memory for durable, cross-project context.
- Do not sync, copy, or hand-maintain native `~/.codex/memories` through the primary memory repo.

Before non-trivial answering or editing, read:

1. `/Users/johngoal/Documents/公园日常工作/memory/00_BOOT/BOOT_CONTEXT.md`
2. `/Users/johngoal/Documents/公园日常工作/memory/00_BOOT/RETRIEVAL_RULES.md`

Then retrieve task-relevant memory with:

```bash
python3 /Users/johngoal/Documents/公园日常工作/tools/memory_search.py "<task keywords>" --memory-root /Users/johngoal/Documents/公园日常工作/memory --limit 5
```

## Local Memory Retrieval Gate

For any non-trivial John request, do a quick primary-memory pass after considering any injected native-memory summary:

1. Extract project names, paths, people, companies, tools, events, documents, and decision keywords from the request.
2. Search the primary local memory first with `tools/memory_search.py`; keep the first pass small, usually `--limit 5`, and do not load all curated files by default.
3. If the request refers to previous work, a known project, a recurring workflow, or a "last time / before / continue" context, open the relevant curated detail file first; open raw session captures only for exact provenance.
4. Use local-memory hits to shape the answer; if there is no relevant hit after a small pass, continue normally and do not broaden into a full-memory scan unless the task explicitly requires historical provenance.
5. Treat memory as orientation, not runtime truth. Recheck live repo, runtime, database, deployment, or logs when the task depends on current state.
6. If native memory and primary memory disagree, recheck runtime facts first and prefer explicit `AGENTS.md` rules plus reviewed primary memory for durable John-level context.
7. Do not rely only on injected/global memory summaries when this local primary memory source is available.

Project-local notes may exist, but durable John-level preferences, cross-project rules, and machine handoff policy should be proposed back to the primary memory source instead of drifting locally.

For engineering tasks, follow:

```text
请遵守 john-engineering-discipline 规则。
```
<!-- END JOHN PRIMARY MEMORY SOURCE -->
