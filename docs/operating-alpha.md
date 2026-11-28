# Operating the hosted Alpha

What to do when the hosted install (the production host and the develop host, the `PRODUCTION_HOST` and `DEVELOP_HOST` variables) is
broken. It is written for the maintainers who run it. A self-hoster's install is in `../deploy/README.md`
and `../selfhost/README.md`.

Everything here runs from GitHub Actions in this repository or from the Vercel CLI, signed in to the team
that owns the project. No step needs a secret typed by hand. `<team>` in a command is that team: the
`VERCEL_SCOPE` variable of the `web-production` environment, which
`gh api repos/<owner>/<repo>/environments/web-production/variables/VERCEL_SCOPE --jq .value` prints. Run
the `gh` commands from a checkout of this repository, or add `-R <owner>/<repo>`.

## How a deploy reaches a host

`.github/workflows/deploy.yml` is the only way a commit reaches the Vercel project.

- A push to `main` builds a preview and points the develop host at it once its smoke passes.
- A release tag (`vX.Y.Z`, `vX.Y.Z-preview.N`, `vX.Y.Z-rc.N`) builds for production, and promotes it to
  the production domain once its smoke passes.
- Before either build, if the push or tag adds a migration, the job snapshots the database as a Neon branch
  `pre-<name>` and migrates it. `<name>` is the tag on production and `develop-<short sha>` on develop.
  The run's summary names the branch. The newest three snapshots are kept.
- Every run's summary records the deployment the host served before it ("... served <url> before this run").
  That URL is what a rollback goes back to.

The smoke (`.github/scripts/deploy-smoke.sh`) ends in one verdict line:

| Verdict | Meaning | What the job does |
| --- | --- | --- |
| `verdict 0` | a guest turn answered | the host moves to the new build |
| `verdict 1` | the build is at fault: the old build answers the same turn | the host never moves, or moves back. On develop a revert of the merge is opened |
| `verdict 2` | the provider is down: neither build answers | the deploy goes ahead, the alerts channel is told, and a recheck smokes the host every 15 minutes for 3 hours |

A deploy that moved the host back is red, and its log says "moving it back to <url>".

## Roll back a release

Use this when production serves a bad build and the job did not move it back. One example is a release
that passed its smoke but breaks something the smoke doesn't check.

1. Open the bad release's Deploy run and read the line "<production host> served <url> before this run".
   If the bad release was itself a rollback target, use the run of the last release you trust instead.
2. Promote that deployment:

   ```sh
   vercel promote <url> --yes --scope <team>
   ```

   This is the command the job runs when its smoke fails, which also passes `--token`; from your own
   machine a signed-in Vercel CLI is enough. It moves the domain at once and builds nothing.
3. Check it: `vercel inspect https://<production host> --scope <team>` names the deployment you promoted,
   `curl -s https://<production host>/chat/healthcheck` answers 200, and the thing users reported works
   again in the browser. The health check can't see most breakage, so the last check is the one that counts.
4. Decide about the database. If the bad release added a migration, the old build now runs on the new
   schema. `.github/workflows/migrations.yml` checks every migration on a pull request so that the build
   before it still runs, so this is normally the whole rollback. The old build cannot run on the new
   schema when its logs show schema errors such as `column "..." does not exist` on ordinary requests.
   Then restore the database (below).

On develop the same steps apply with `vercel alias set <url> <develop host> --scope <team>`. A develop host
that a merge broke is better fixed by merging the revert the job opened.

## Prove the production gate holds

Do this after a release whose deploy changed `deploy.yml` or `.github/scripts/deploy-smoke.sh`, and at least
once per minor version. Each run builds a deliberately broken copy of the release and checks that the smoke
keeps it off the domain. The domain must not move, so users never see the broken copy.

1. Wait for the release's own Deploy run to finish green
   (`gh run list --workflow deploy.yml --branch <tag> --event push --limit 1` names it), and note the
   deployment id (`dpl_…`) the domain serves: `vercel inspect https://<production host> --scope <team>`.
2. Run Deploy by hand on the release tag, once per mode:

   ```sh
   gh workflow run deploy.yml --ref <tag> -f prove_red=identity
   gh workflow run deploy.yml --ref <tag> -f prove_red=answer
   ```

   Start the second once the first has finished: both use the production concurrency group, so the second
   waits anyway. `identity` deploys without the identity file. `answer` deploys with every input safety
   screen on a closed port, so every turn is declined. `provider` runs on develop only.
3. Read each run's "Smoke the deployment before the domain moves" step. A pass looks like this:
   - `identity`: a line saying `/api/status` names status page 'none' and the build lost its identity, then
     `verdict 1: the build is at fault`.
   - `answer`: `SMOKE FAIL: the safety screen declined the turn`, then the same turn sent to the deployment
     the domain serves, which answers it and prints `SMOKE PASS` (that pass is the served build's, not the
     broken copy's), then `verdict 1: the build is at fault`.

   In both, the run is red and "Move the domain to this deployment" is skipped.
4. Run `vercel inspect` again. It must name the same deployment id as in step 1. If it names a prove-red
   deployment, roll back (above) at once: the gate failed.
5. Post the two run links in the alerts channel, as evidence the gate held for that release.

A run that ends `verdict 0` or moves the domain is a broken gate, not a passed test. Treat it as an incident.

## Restore the database from a snapshot

This is a last resort. A restore removes every write made since the snapshot, including conversations,
messages and settings. Those writes are kept on a branch `rolled-back-<name>-<run id>` and must be copied
back by hand.

1. Roll the code back first (above). Restore only if the build you rolled back to cannot run on the
   migrated schema.
   A restore loses users' writes, so the maintainer who decides it says so in the alerts channel before
   running it.
2. Run **Restore a database from its snapshot** (`db-restore.yml`) from the Actions tab:
   - production: pick the bad release's own tag as the ref (its snapshot was taken just before it
     migrated), choose `production`, and type the same tag in `confirm`. It restores from `pre-<tag>`.
   - develop: run it from `main`, choose `develop`, and type the name after `pre-` (for example
     `develop-1a2b3c4`) from the deploy run's summary.
   Any other ref, or a `confirm` that doesn't match, stops the run before anything is touched.
3. The run's summary prints how long the restore took. In a rehearsal on the develop database (430 MB),
   the restore call took 6.4 s and the database answered queries 8.6 s after it started. The host served
   a guest turn straight after.
4. Check the app answers a guest turn, then copy back any writes you need from the `rolled-back-` branch.
   It is an ordinary Neon branch: connect to it from the Neon console and copy rows across with `pg_dump
   --data-only --table=...` into the restored branch. Nothing deletes it automatically (the deploy's
   pruning removes only `pre-` branches), so delete it in the Neon console once nothing more is needed.

Production holds `NEON_API_KEY`, `NEON_PROJECT_ID` and `NEON_BRANCH_ID` in its `web-production`
environment. An environment without them takes no snapshots, migrates inside the build, and cannot be
restored this way.

## What watches the hosted install

The deploy smoke and the app's own scheduled job run from this repository. The other checks run from the
maintainers' monitoring, outside it, and post to the same alerts channel.

| Check | How often | Where it tells |
| --- | --- | --- |
| The deploy smoke | every deploy | the run, the alerts channel on verdict 2 |
| The app's scheduled job (`/chat/api/probes`, in `web/vercel.json`): the safety screen and the judge, each sent a probe through the real screening path | every 3 minutes, on production only | the alerts channel, after three failed probes in a row |
| A real chat turn against production | scheduled every 20 minutes; GitHub delivers it about every 90, at worst about 4 hours apart | the alerts channel, after two failed runs |
| The same turn against develop | hourly | the alerts channel |
| `/chat/healthcheck` URL monitor | every 3 minutes | email |
| The release watchdog: production serves the newest release | scheduled every 15 minutes, delivered later | the alerts channel, then a red run once it has drifted for over an hour |

`/chat/healthcheck` answers 503 only when the model registry can't serve a turn. It answers 200 while a
safety screen or the judge fails closed.

**A build that is healthy but declines every turn.** On production, the scheduled job alerts in about 10
minutes when the safety screen or the judge fails closed. A decline with any other cause shows only on the
real chat turn, which can take about 5 hours in the worst case, or on the deploy smoke if a deploy caused it.

Develop has no alert after a deploy. Vercel runs the scheduled job only on a production deployment, and
develop is a preview with no alerts webhook, so a screen that dies there after the smoke passed is not
reported. If users report every message being declined, send a guest turn yourself before trusting the
health check.

## Read logs, errors and status

- **Logs.** The Vercel project streams logs live: `vercel logs <deployment url> --scope <team>`. The
  retained copy is in the log drain the project sends to. Search it by the request id a user's error shows.
- **Errors and latency.** PostHog has the error tracking and the per-turn `latency_ms` and `ttft_ms`.
- **Status.** The public status page is linked from the app's menu. It shows the URL monitor's state.
- **Which build is live.** `vercel inspect https://<production host> --scope <team>` names the
  deployment, and its git commit is the release.

## Who to tell

The alerts channel is the Slack channel the deploy job posts to (`SLACK_ALERT_WEBHOOK` in each
environment); maintainers already have it.

- An incident users can see: post in the alerts channel what is broken, since when, and what you did. Say
  when it is fixed.
- A security problem: follow `../SECURITY.md`, and don't describe it in a public issue or commit.
- A rollback or a restore: say which release or snapshot, in the alerts channel and on the release's
  pull request (the GitHub release for the tag links it), so the next release starts from what is really
  live.
