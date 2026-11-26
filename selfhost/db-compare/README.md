# What each chat app leaves readable in its database

`run.sh` gives Open WebUI, LibreChat and Alpha the same ten chats, then dumps each app's database and
shows where the chat text sits readable. It answers one question an operator choosing between them
can't easily answer from their docs: after people use it, what does a copy of the database show?

The latest results are in [`results.md`](results.md).

## What it does

1. Starts each app as its own docs start it, on its default store:
   - Open WebUI v0.13.4 on SQLite;
   - LibreChat v0.8.9 on MongoDB, with its `.env.example` defaults (`SEARCH=false`, so no Meilisearch
     index);
   - Alpha's self-host stack on Postgres, built from this checkout.
2. Points all three at one stand-in model (`stub.py`) that answers every request, titles included, with
   a fixed sentence holding the answer canary `ANSWER-KESTREL-9302`. No prompt leaves your machine.
3. Signs up one account on each app and types ten new chats into the app's own chat page, in Chromium
   (`chats.mjs`). Each message holds the user canary `PLUM-HERON-4471`.
4. Dumps each store whole (`webui.db` as SQL, `mongodump --archive`, `pg_dump`) and reports two numbers
   per canary:
   - **fields**: every table and column (collection and field path for MongoDB) holding the canary, with
     how many rows hold it (`fields-*.{py,js,sql}`);
   - **grep**: how many times the canary appears in the dump file.

A canary found in a field means anyone with a copy of the database, a backup or the server's disk can
read that text. A canary absent from every field and from the dump means the app stored it sealed, or
not at all.

## Run it

You need Docker with Compose v2.24 or newer, `openssl`, Node and pnpm. From the repository root:

```bash
(cd web && pnpm install && pnpm exec playwright install chromium)
selfhost/db-compare/run.sh            # all three apps, results in selfhost/db-compare/out/
APPS=alpha selfhost/db-compare/run.sh # one app
```

The first run pulls each app's images. Each app runs in its own
Compose project (`dbcompare`, and `dbcompare-alpha` on port 3300), with secrets generated per run, and
everything is removed at the end (`KEEP=1` leaves it running). An Alpha stack you already run on the
default project and port is not touched, and your own .env file is not read. `ALPHA_IMAGE` runs a
published Alpha image (`../compose.release.yaml`) in place of the build.

`out/` holds the table (results.md), each app's dump, its per-field counts (`<app>-fields.tsv`) and the chat log
(`<app>-chats.json`, with a screenshot if a chat failed). In CI, the `DB compare` workflow runs the same
script on a PR labelled `db-compare`, or by hand once it is on `main`, and keeps `out/` as its artifact.

## What it does not cover

- **Settings other than the defaults.** Alpha seals a chat only with the `history-seal-writes` flag on and
  a history key the owner's browser has enrolled (`web/src/lib/chat/server/chat/sealedTurn.ts`); neither
  is a self-host default, so this run shows Alpha's plaintext default. Any encryption setting Open WebUI
  or LibreChat may offer is likewise left off.
- **Files.** The chats upload nothing, so where each app keeps an uploaded file is not measured.
- **Logs.** Container logs are not searched. Only the databases are.
