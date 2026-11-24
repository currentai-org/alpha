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
- A release is a semver tag, `v0.x.y`; there are no date tags. A release pull request writes the
  changelog and calls out any database migration and any breaking configuration change.
- Each tag gets one container image on GHCR, signed with cosign, with an SBOM and a provenance
  attestation. The `main` tag is the edge build.
- The hosted instance deploys the way a self-hoster would: `main` goes to staging, and production moves
  when a tag is cut.
- If you run Alpha yourself, pin a tag or a digest, not `main`.

## Report an issue

Open a GitHub issue for bugs, unclear code, or a hosted service you couldn't replace. Include the file
path and line number where possible. Report a vulnerability as `SECURITY.md` describes, not in an issue.

## Run the checks

CI runs these on every pull request and every push to `main`, and none of them reads a secret:

```sh
pnpm install --frozen-lockfile
cd web
pnpm lint
pnpm check
pnpm i18n:compile && pnpm test:ci:fast
pnpm build
```

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
