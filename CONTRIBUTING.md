# Contributing

Contributions are welcome as issues and discussion.

## How this repository works for now

This repository is a published snapshot. Alpha's code is still developed in a private repository that
also holds the AI Potluck website, and it arrives here one commit at a time. Moving development here is
under way. Once this repository becomes the source of truth, code pull requests open here, and this file
will say how they are reviewed and merged.

Until then, a code pull request can't be merged here. If you have a change in mind, open an issue that
describes it. The maintainers read every issue and carry worthwhile changes into the next snapshot.

## Report an issue

Open a GitHub issue for bugs, unclear code, or a hosted service you couldn't replace. Include the file
path and line number where possible. Report a vulnerability as `SECURITY.md` describes, not in an issue.

## Run the checks

CI runs these on every push to `main`, and no job reads a secret:

```sh
pnpm install --no-frozen-lockfile
cd web
pnpm i18n:compile
pnpm test:ci:fast
```

For `agent-service/`, run `make venv` and `make test` in that directory (`agent-service/README.md` has
the details).

## Fork the project

You don't need to contribute changes back. `README.md` lists the hosted services the app expects and
the environment variable for each. `AGENTS.md` maps the codebase for coding agents.

## Code of conduct

All participants follow the [Code of Conduct](CODE_OF_CONDUCT.md).
