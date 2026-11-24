## What changes

<!-- One or two sentences a reader understands without opening the diff. -->

## Why

<!-- The problem it solves. Link the issue: "Closes #123". -->

## How it was checked

<!-- What you ran or clicked, and what you saw. "pnpm test:ci:fast passes" is a start; a spec that drives
     the change, or the steps to see it in the app, is better. -->

## Kind

<!-- Add the label that fits, so the release notes put this change in the right group: `breaking` if
     someone running their own copy must do something when they upgrade, `security`, `bug` for a fix,
     `enhancement` for something new. A bot adds `selfhost` and `ci` from the paths you change. Use
     `skip-changelog` for a change nobody running Alpha would notice. -->

## Checklist

- [ ] `pnpm lint` and `pnpm test:ci:fast` pass in `web/` (or `make test` in `agent-service/`)
- [ ] The pull request targets `main`; this repository has no `develop` or `release` branch
- [ ] If it adds a database migration or changes configuration in a way that breaks an existing install,
      the description says so, so the release pull request can carry it into the changelog
- [ ] No secrets, private hostnames or personal data in the diff, the title or this description
- [ ] If an AI tool wrote part of this, I say which one here, and I understand every line of the change
