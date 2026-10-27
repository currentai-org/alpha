# Contributing

This repository is published as a snapshot of a private monorepo. Each release replaces the previous
snapshot in full.

## Report an issue

Open a GitHub issue for bugs, unclear code, or a hosted service you couldn't replace. Include the file
path and line number where possible.

## Propose a change

Pull requests aren't merged in this repository, because the next snapshot overwrites them. When a
change fits, we apply it in the monorepo and it ships in the next snapshot.

- Keep each pull request to one change.
- For larger changes, open an issue first to confirm the approach.
- Pull requests are accepted under this repository's licences: MIT for most files, and Apache-2.0 for
  files derived from chat-ui. See `README.md`, "Licence".

## Run the checks

```sh
cd web
pnpm install --no-frozen-lockfile
pnpm check
pnpm lint
pnpm test:ci:fast
```

For changes to `agent-service/`, run `make test` in that directory.

## Fork the project

You don't need to contribute changes back. `README.md` lists the hosted services the app expects and
the environment variable for each. `AGENTS.md` maps the codebase for coding agents.

## Code of conduct

All participants follow the [Code of Conduct](CODE_OF_CONDUCT.md).
