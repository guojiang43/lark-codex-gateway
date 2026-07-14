# Contributing

1. Open an issue for significant behavior or protocol changes.
2. Create a focused branch and keep unrelated edits out of the patch.
3. Add a failing test or reproducible case before changing behavior.
4. Never add App Secrets, tokens, private keys, Codex auth state, real user messages, production databases/logs, personal paths, or real App ID/open_id values.
5. Run the full verification suite:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

By contributing, you agree that your contribution is licensed under the MIT License.
