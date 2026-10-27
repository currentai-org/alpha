# Upstream: huggingface/chat-ui

`web/src/lib/chat` and `web/src/routes/chat` were forked at upstream commit
[`caaf9071`](https://github.com/huggingface/chat-ui/commit/caaf90712ce966f45c0ad171f17f0b619861b0c3)
(2026-06-17). Upstream changes through
[`f0e7d24d`](https://github.com/huggingface/chat-ui/commit/f0e7d24dfa16c3ac88cf27212869548e249194ea)
have been reviewed and ported by hand where they fit.

Files derived from chat-ui stay under its Apache-2.0 licence (`web/LICENSE.chat-ui`).

## What changed

Much of what came from upstream has since been rewritten:

- Persistence is Postgres (Drizzle, `web/drizzle/`) instead of MongoDB.
- The OpenAI-compatible endpoint (`web/src/lib/chat/server/endpoints/`) and the conversation route
  (`web/src/routes/chat/conversation/[id]/+server.ts`) carry provenance, web-search grounding, the
  safety screen and agent mode.
- Model choice per message (Auto) lives in `web/src/lib/chat/routing/`.
- The UI is built on the Alpha design system in `packages/alpha-ds/`.
- Sign-in uses Better Auth.

Because so much has diverged, upstream commits are ported individually rather than merged.
