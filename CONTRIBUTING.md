# Contributing

Issues and pull requests are welcome here.

## How changes reach this repository

Most of Alpha's code is still developed in a private repository that also holds the AI Potluck website,
and it arrives here as snapshots: one commit at a time, each with a subject starting "Alpha source
snapshot". Moving development here is under way.

A pull request opened here is reviewed here, and an accepted one is merged here. Before the next snapshot,
the maintainers carry each change merged since the last one into the private repository. The snapshot
export checks this: it refuses to publish a tree that would revert a change merged here, so a merged
pull request is not lost when the next snapshot lands.

## Report an issue

Open a GitHub issue for bugs, unclear code, or a hosted service you couldn't replace. Include the file
path and line number where possible. Report a vulnerability as `SECURITY.md` describes, not in an issue.

## Propose a change

- Keep each pull request to one change.
- For larger changes, open an issue first to confirm the approach.
- CI runs on every pull request, including one from a fork. It installs the workspace and runs the web
  unit tests and the agent-service lint and tests, and no job reads a secret. A change has to pass it
  to merge.
- If a coding agent helped write the change, say so in the pull request, and run the checks below
  yourself. You answer for the change either way.
- Pull requests are accepted under this repository's licences: MIT for most files, and Apache-2.0 for
  files derived from chat-ui. See `README.md`, "Licence".

## Run the checks

```sh
pnpm install --no-frozen-lockfile
cd web
pnpm i18n:compile
pnpm test:ci:fast
pnpm check
pnpm lint
```

For changes to `agent-service/`, run `make venv`, `make lint` and `make test` in that directory
(`agent-service/README.md` has the details).

## Fork the project

You don't need to contribute changes back. `README.md` lists the hosted services the app expects and
the environment variable for each. `AGENTS.md` maps the codebase for coding agents.

## Code of conduct

All participants follow the [Code of Conduct](CODE_OF_CONDUCT.md).
