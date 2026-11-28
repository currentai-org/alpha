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

Up to 150 users that stack answered every turn offered at full speed. At 300 turns queued, and at 600 it
answered fewer turns than at 300. Runs 46100795711 (levels) and 46109899970 (the climb).

### Where it bends, and why

The climb again, with `PG_POOL_MAX=10` and CPU sampled every few seconds (`deploy/loadtest/cpu-sample.sh`).
A container's 100% is one core. The runner's busy share counts all 4 cores, k6's included.

| Answers | Users | Turns/min | Turn p50 | Turn p95 | First byte p95 | Errors | web CPU | db CPU | k6 CPU | Runner busy |
| ------- | ----- | --------- | -------- | -------- | -------------- | ------ | ------- | ------ | ------ | ----------- |
| instant | 150   | 1,756     | 0.12 s   | 0.15 s   | 0.02 s         | 0%     | 50%     | 36%    | 4%     | 26%         |
| instant | 200   | 2,337     | 0.13 s   | 0.17 s   | 0.03 s         | 0%     | 73%     | 51%    | 6%     | 35%         |
| instant | 250   | 2,902     | 0.14 s   | 0.29 s   | 0.10 s         | 0%     | 90%     | 63%    | 7%     | 44%         |
| instant | 300   | 3,443     | 0.16 s   | 0.63 s   | 0.24 s         | 0%     | 92%     | 73%    | 7%     | 49%         |
| paced   | 150   | 1,340     | 1.7 s    | 2.2 s    | 0.29 s         | 0%     | 102%    | 35%    | 6%     | 45%         |
| paced   | 200   | 1,506     | 2.7 s    | 4.9 s    | 1.5 s          | 0%     | 119%    | 46%    | 6%     | 55%         |
| paced   | 250   | 1,462     | 5.4 s    | 6.8 s    | 2.6 s          | 0.3%   | 133%    | 46%    | 6%     | 57%         |
| paced   | 300   | 1,446     | 7.4 s    | 10.6 s   | 4.7 s          | 2.2%   | 141%    | 44%    | 6%     | 59%         |

CPU is the mean over each 3-minute hold. The database held 10 connections at every level, which is the pool.

**The knee is about 150 users with streamed answers, and the limiter is the one Node process.** From 150 paced
users the web container uses a full core or more, which is the single JavaScript thread plus Node's helper
threads. Past that, added users add only waiting: throughput stops at about 1,500 turns a minute, p95
doubles by 200 users, and at 250 a few turns fail with a 5xx that the app does not log. The rest of the
box is not the limit. The runner is never more than 59% busy, so about 1.6 of its 4 cores sit idle, k6
uses under a tenth of a core, and db CPU stays flat from 200 users up.

Instant answers cost the app much less per turn: about 50% of a core at 1,756 turns a minute, against
102% at 1,340 for streamed ones. So they reach 300 users without a knee, while web climbs to 92% of a core.
At 300 users the pool of 10 made the difference against the run above, where the stack ran on its
single connection: p95 0.63 s against 2.2 s, and 3,443 turns a minute against 3,190.

- **Fixture.** aimock (`deploy/loadtest/aimock.compose.yaml`) with `slow-model/` for paced answers. The app's
  repetition guard (`[loop-cut]` in the logs) stopped every paced answer early, because the fixture repeats
  one span. A paced answer therefore streamed for about 1.6 s. A real answer streams longer, so it holds
  the process for longer.
- **Host.** One GitHub-hosted `ubuntu-latest` runner, 4 vCPU and 16 GB, with k6 on the same box. Image
  `0.3.0-preview.1`, `PG_POOL_MAX=10`, `RATE_LIMIT_IP_MULTIPLIER=0`. Run 46125660813.
- **Going past it.** More cores in one machine do not help, because one Node process uses one of them.
  Run more web processes: several `web` replicas behind a proxy, or a second host. Each process holds its
  own `PG_POOL_MAX` connections, so ten processes at 10 fill stock Postgres's 100. More than one web process
  has not been measured, so check that the rate limits and sessions behave across processes before relying
  on it. A faster core moves the knee up by roughly its speed.

### Five hours at 20 users

The same stack, instant answers, `PG_POOL_MAX` unset, 20 users for 5 hours. It answered 70,188 turns
(234 a minute, p95 171 ms) with no errors, declines, 429s or 5xx. Memory was sampled once a minute:

- web held flat: 656 MiB after the first hour, 655 MiB over the last ten minutes.
- db went from 78 to 163 MiB, and 140 MiB of the end figure is shared memory: Postgres's 128 MiB buffer
  pool, which was full at the end. Process memory stayed at 7 MiB. Over the last 100 minutes db grew 1.5%.
- the database grew from 50 MB after the first hour to 186 MB at the end, about 2.4 KB per turn over
  those four hours.

No leak showed in 5 hours. Run 46102086636, image `0.3.0-preview.1`.

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
- Long answers. The paced answers stream for under 2 s; a real answer can hold a connection open for a
  minute, so a real deployment holds fewer users at once than the compose rows show.
