# Design-system changelog

Each change has one file, named `YYYY-MM-DD-<slug>.md`. The design system's version is derived
from these files: `major.minor.patch` counts the entries of each kind, so there is no version number
to edit.

Create entries with `pnpm ds:change "<summary>"` from `web/`. The command creates this branch's entry,
or updates the one the branch already added, and fills in the `surface` block with the public names
added or removed. You can edit the notes below the frontmatter. To change the `surface` block, rerun
the command.

The changelog renders at `/designsystem/changelog`. [../README.md#versioning](../README.md#versioning)
describes the rules.
