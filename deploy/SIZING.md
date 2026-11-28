# Sizing an Alpha deployment

How many people one deployment holds, and how big its database gets, from a measured load run and from
production's own aggregates. The serverless run below used a k6 harness that stays with the hosted
instance's own deploy files. The compose run uses the same k6 script, in `deploy/loadtest/`, run by
`.github/workflows/load.yml` on a pull request labelled `load-run` or by hand.

## What the run measured

k6 drove the PR's own Vercel preview on its own Neon branch, with the functions in fra1 beside the
database in eu-central-1. Each virtual user is a guest who opens a conversation, sends a turn, reads
the whole answer stream, waits 5 s and sends the next. Each level holds for 2 minutes after a 20 s
ramp, and only the hold is reported.

Turns used the preview's canned reply, with the screens stubbed, so no model ran. Everything else ran
for real: the session, the conversation load, the rate-limit counts, persistence and the stream. The
numbers measure the app and its database, never inference.

| Pass   | Users | Turns/min | Turn p50 | Turn p95 | First byte p95 | Errors | Peak DB connections |
| ------ | ----- | --------- | -------- | -------- | -------------- | ------ | ------------------- |
| bare   | 20    | 208       | 0.8 s    | 0.9 s    | 0.3 s          | 0%     | 8                   |
| bare   | 60    | 613       | 0.8 s    | 1.5 s    | 0.3 s          | 0%     | 15                  |
| bare   | 150   | 1,238     | 1.4 s    | 7.2 s    | 0.3 s          | 0%     | 22                  |
| seeded | 20    | 209       | 0.8 s    | 0.9 s    | 0.3 s          | 0%     | 22                  |
| seeded | 60    | 618       | 0.8 s    | 1.3 s    | 0.3 s          | 0%     | 22                  |
| seeded | 150   | 1,328     | 1.1 s    | 5.1 s    | 0.3 s          | 0%     | 29                  |

The seeded pass ran after the harness's seed script added 2,000 synthetic accounts and 10,000
conversations of four messages each. Peak connections for the seeded pass include connections left
over from the bare pass. There were no 429s and no 5xx at any level.

**The deployment held 150 users at about 1,300 turns a minute with no errors.** Each simulated user
sends a turn every 6 s or so, which is far faster than a person reads. A person sends perhaps one turn
a minute, so 1,300 turns a minute is on the order of a thousand people chatting at once. That
conversion is an estimate; the measured quantity is turns a minute. The run did not find the ceiling.

### Put the functions beside the database

An earlier run had the functions in iad1 and the database in Frankfurt. Every query crossed the Atlantic: the
settings read took 188 ms at p50, where it takes 6 ms beside the database. Each instance's 25 pooled
connections were then held long enough to queue. At 150 users, 31% of turns failed (43% before the
seed) and p95 hit k6's 120 s timeout. Same harness, same pool, same database size.

On Vercel, the build puts the functions beside the Neon host in `DATABASE_URL` unless
`FUNCTION_REGION` names a region (`web/src/lib/functionRegion.js`). For any other host, set
`FUNCTION_REGION` to the database's region.

## The compose stack on one host

`deploy/compose.yaml` on one GitHub-hosted runner (4 vCPU, 16 GB), with aimock as the model, so again no
inference ran. The same k6 script and guests, 3-minute holds. The load generator shares the runner's CPUs,
so the bend below is where this box bends, k6 included.

| Answers | Users | Turns/min | Turn p50 | Turn p95 | First byte p95 | Errors | Peak DB connections |
| ------- | ----- | --------- | -------- | -------- | -------------- | ------ | ------------------- |
| instant | 60    | 704       | 0.11 s   | 0.12 s   | 0.01 s         | 0%     | 1                   |
| instant | 150   | 1,759     | 0.11 s   | 0.12 s   | 0.01 s         | 0%     | 1                   |
| instant | 300   | 3,190     | 0.26 s   | 2.2 s    | 1.0 s          | 0%     | 1                   |
| instant | 600   | 2,947     | 7.3 s    | 10.8 s   | 5.2 s          | 0%     | 1                   |
| paced   | 60    | 549       | 1.6 s    | 1.6 s    | 0.02 s         | 0%     | 2                   |
| paced   | 150   | 1,359     | 1.6 s    | 1.8 s    | 0.15 s         | 0%     | 1                   |
| paced   | 300   | 1,685     | 5.7 s    | 8.2 s    | 3.3 s          | 0%     | 1                   |
| paced   | 600   | 1,601     | 17.3 s   | 19.7 s   | 10.2 s         | 2.0%   | 1                   |

"Paced" answers stream for about 1.6 s each (`deploy/loadtest/slow-model/`). No turn was declined.
`PG_POOL_MAX` was unset, as the stack ships. At 20 and 60 users with instant answers, setting it to 10 made no
measurable difference (p95 125 ms against 126 ms).

**About 150 concurrent users on one 4-vCPU host, limiter not yet identified.** Up to 150 the stack answers
every turn offered at full speed; at 300 turns queue, and at 600 it answers fewer turns than at 300. The
single database connection, the single Node process and k6's share of the CPUs are all candidates, and this
run cannot tell them apart. Runs 46100795711 (levels) and 46109899970 (the climb).

## Database size

From production, read as aggregates only, on 2026-11-06:

- A stored conversation takes about 11.1 KB on disk with its indexes (19 MB across 1,823
  conversations). The p90 conversation's document is about twice the average.
- A signed-in account keeps about 8.5 conversations.
- So 1,000 active accounts need about 95 MB for conversations, or about 185 MB if every conversation
  were p90-sized. Rate-limit events, settings and accounts add a few MB more.

A 1 GB Postgres volume holds roughly 10,000 active accounts at today's usage, before uploads, which are
stored outside the database.

## Connections

On Vercel each function instance holds up to `PG_POOL_MAX` connections: 25 on Current AI's deployments,
or 1 when it is unset. The run peaked at 29, through Neon's pooler. The pooler takes 10,000 client
connections and keeps up to 90% of `max_connections` open to Postgres; the PR's branch allowed 901,
which is about 810.

The compose stack (`deploy/compose.yaml`) runs one long-lived Node process, so the default of 1 sends
every request's queries down one connection. Set `PG_POOL_MAX` to 10 or so there. Stock Postgres allows
100 connections.

## Limits that bound one account

These hold any single account to a share of the deployment's capacity:

- 20 turns a minute per session, plus a per-IP ceiling (`web/src/lib/chat/server/chat/rateLimit.ts`)
- 200 chat turns a day per account, 2,000 for a team account (`web/config/chatTurns.ts`).
  Production's busiest account-day over 60 days was 55 turns.
- a service-wide daily request cap, `GLOBAL_DAILY_REQUEST_CAP`

## What this does not cover

- Inference. A real model adds its own time to first token and its own concurrency limit, and on a
  real deployment that is usually the first limit reached.
- Long answers. The canned reply sends three short pieces at once; a real answer can hold a connection
  open for a minute.
- The compose stack itself. This run was serverless on Neon. A single Node process with a raised
  `PG_POOL_MAX` has not been measured yet.
