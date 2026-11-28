# Contributing

Contributions are welcome as issues and discussion.

## How this repository works for now

This repository is a published snapshot. Alpha's code is still developed in a private repository that
also holds the AI Potluck website, and it arrives here one commit at a time. Moving development here is
under way. Once this repository becomes the source of truth, code pull requests open here, and this file
will say how they are reviewed and merged.

Until then, a code pull request can't be merged here. If you have a change in mind, open an issue that
describes it. The maintainers read every issue and carry worthwhile changes into the next snapshot.

## Branches and releases

When development moves here, the model is trunk-based:

- Branch off `main`, keep the branch short-lived, and open a pull request. The merge queue merges it
  once its checks pass. There is no long-lived `develop` or `release` branch. A maintenance branch
  `release/vX.Y` appears only when an older line needs a patch.
- A pull request's title is a conventional commit (`fix: …`, `feat(chat): …`, `!` before the colon for
  a breaking change), because it becomes the squash commit that the changelog is built from.
- A release is a semver tag, `v0.x.y`; there are no date tags. release-please keeps a release pull
  request open on `main` with the next version and `CHANGELOG.md`. Before merging it, add any database
  migration or breaking configuration change to its notes. Merging it tags `main`, and that cuts the
  release.
- Each tag gets one container image on GHCR, signed with cosign, with an SBOM and a provenance
  attestation. The `main` tag is the edge build.
- The hosted instance deploys the way a self-hoster would: every merge to `main` deploys to its develop
  host, and a release tag deploys production (`.github/workflows/deploy.yml`).
- If you run Alpha yourself, pin a tag or a digest, not `main`.

## Report an issue

Open a GitHub issue for bugs, unclear code, or a hosted service you couldn't replace. Include the file
path and line number where possible. Report a vulnerability as `SECURITY.md` describes, not in an issue.

## Run the checks

CI runs these on every pull request and every push to `main`:

```sh
pnpm install --frozen-lockfile
cd web
pnpm lint && pnpm selfhost:flag-table
node scripts/gen-env-ci.mjs && cp .env.ci .env && pnpm check
pnpm i18n:compile && pnpm test:ci:fast
pnpm build
```

### Run the whole pull request gate with act

[act](https://github.com/nektos/act) runs `.github/workflows/ci.yml` itself in Docker, so a local pass
covers the same jobs as the pull request gate. From your branch, with `upstream` pointing at this
repository:

```sh
git fetch upstream main
printf '{"pull_request":{"base":{"sha":"%s"},"head":{"sha":"%s"}}}' \
  "$(git merge-base HEAD upstream/main)" "$(git rev-parse HEAD)" > /tmp/act-event.json
act pull_request -W .github/workflows/ci.yml -e /tmp/act-event.json --privileged \
  -P ubuntu-latest=catthehacker/ubuntu:act-latest
```

The event file gives the two leak checks the commit to diff against; without it they fail at once.
`--privileged` lets the agent-service sandbox tests create namespaces. It gives the job containers
full access to your Docker host, so drop it if you'd rather not, and expect those tests to fail.

What a local pass leaves unchecked:

- **Forbidden text in added lines.** Its pattern list is a repository secret you don't have, so the job
  passes with a warning and the merge queue runs the check.
- **The self-host smoke and image jobs** (`selfhost.yml`, `image.yml`). They aren't in `ci.yml`.
- **The end-to-end suite** (`e2e.yml`), which needs a preview deployment.

`selfhost/smoke.sh` boots the self-host stack and sends one chat turn; CI runs it when `selfhost/` or the
image changes. The end-to-end suite runs against a preview deployment and needs maintainer approval, so
it runs only for branches in this repository.

For `agent-service/`, run `make venv` and `make test` in that directory (`agent-service/README.md` has
the details).

## Fork the project

You don't need to contribute changes back. `README.md` lists the hosted services the app expects and
the environment variable for each. `AGENTS.md` maps the codebase for coding agents.

## Code of conduct

All participants follow the [Code of Conduct](CODE_OF_CONDUCT.md).
