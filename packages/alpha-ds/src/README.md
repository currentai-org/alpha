# Alpha design system (`@aipotluck/alpha-ds`)

`@aipotluck/alpha-ds` styles the chat at `/chat` and the `/alpha` embed. It provides the Potluck
skin, chat-app layout patterns (app shell, sidebar, composer), OKLCH light and dark theming, and
components with the same anatomy as [Base UI](https://base-ui.com), so you can upgrade them from Base
UI's own docs.

To browse it, run the dev server and open [`/designsystem`](/designsystem). Each token, component,
primitive and pattern has a live preview, its code, an anatomy diagram and API tables. Press
<kbd>⌘K</kbd> to search.

## Layers

| Layer          | What                                                                                                                              | Where                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Tokens**     | OKLCH colour ladder (light + dark) derived from a few seeds, plus type, space, radius, motion, z-index                            | `tokens/`            |
| **Components** | Reusable, skinnable parts in Base UI anatomy (`Dialog.Root`, `Dialog.Popup`…)                                                     | `components/<name>/` |
| **Primitives** | Layout that groups elements (`Surface`, `Stack`, `Inline`, `Grid`, `Center`, `Frame`)                                             | `primitives/<name>/` |
| **Patterns**   | Page structure for the chat app (`AppShell`, `Sidebar`, `ThreadHeader`, `Composer`, `ComposerAccessory`, `Message`, `EmptyState`) | `patterns/<name>/`   |

The layers are listed bottom up. Everything is exported from one barrel: `import { Dialog, Stack, AppShell } from '@aipotluck/alpha-ds'`.

## Folder map

```
alpha-ds/
  index.ts                 public API (the only import path consumers use)
  styles.css               stylesheet entry, imported once by src/app.css
  tokens/
    scales.ts              SOURCE: type, space, radius, motion, z, shadows
    themes.ts              SOURCE: theme seeds (a dozen inputs per theme)
    color/oklch.ts         OKLCH math, gamut mapping, WCAG contrast
    color/derive.ts        seeds → full semantic ladder, contrast-solved
    build.ts               pure builders for every generated output
    generated/             tokens.css · tailwind.css · tokens.json (DTCG) · manifest.json
    variants.css           ui-* state variants (Base UI + engine attributes)
    utilities.css          spec rules as utilities (tint layers, motion)
    base.css               .ds-root base layer (type, focus ring, selection)
    legacy-bridge.css      --ap-* / grey ramp → tokens (removed once no legacy reads remain)
  theme/                   ThemeProvider, colour-mode state, portal host
  internal/                cn/tv (token-aware class merging), Positioner, Portal, contexts
  components/<name>/       Part files + <name>.recipe.ts + index.ts + <name>.docs.ts + examples/
  primitives/<name>/       same shape
  patterns/<name>/         same shape
  catalog/                 docs contract (types.ts), registry, /designsystem UI
  changelog/               one entry per change; the version is derived from these
  version/                 ledger.ts (parse + fold), changelog.server.ts (page data), version.spec.ts
  docs/                    ARCHITECTURE · ADDING-A-COMPONENT · BASE-UI-UPGRADE · VERIFYING · FEATURE-HOMES · XRAY-PROPOSAL
```

The lint plugin is in `web/eslint-rules/alpha-ds/`, with the repository's other local ESLint rules.

## Change how the app looks

Find the change you want in the first column, edit the file in the second, then run the step in the
third.

| You want to…                                        | Edit                                                                                            | Then                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Change a colour, the accent, the dark/light grounds | seeds in `tokens/themes.ts`                                                                     | `pnpm ds:tokens`                                      |
| Change type sizes, radii, spacing, motion           | `tokens/scales.ts`                                                                              | `pnpm ds:tokens`                                      |
| Change how one component looks                      | its `<name>.recipe.ts` (all visual decisions live there)                                        | —                                                     |
| Let people build their own theme                    | `theme/custom.ts` (Settings → Appearance → Advanced)                                            | `ThemeProvider persistCustom="key"`                   |
| Try a theme live before committing it               | `/designsystem/theming` playground                                                              | copy seeds into `themes.ts`                           |
| Add a theme                                         | add a `ThemeSeeds` object to `themes` (colours + optional `structure`: radii, shadows, UI type) | `pnpm ds:tokens`; it appears in Settings → Appearance |

`color/derive.ts` expands the seeds into about 30 semantic tokens per mode. Text tiers are solved
against WCAG contrast targets. `tokens.spec.ts` fails when any theme or mode misses a target, so a
seed change can't produce unreadable text.

## Colour, modes and surfaces

- Each colour token is one declaration: `light-dark(<light>, <dark>)`. The mode is the
  `color-scheme`, set by `data-mode="light|dark|system"` on a `.ds-root`. Switching needs no
  JavaScript or class swap, and `system` follows the OS setting as it changes.
- A subtree can switch mode with `data-mode` on any element. The footprint card uses this to render
  light on dark, and the chrome bar uses it to stay black.
- **Surface context.** `<Surface level="2">` (or any `data-surface`) tells descendants which surface
  they sit on. Bordered controls rest on `bg-surface-raised`, one tier up, as the design spec
  requires. Rules use `border-line-surface`, which steps up to Border 3 on Background 3.

Token utilities: `bg-surface-{1,2,3}` · `text-fg-{1,2,3}` · `border-line-{1,2,3,strong}` ·
`bg-accent-1` / `text-accent-1-text` · `rounded-{sharp,field,pill,popup,card}` · `text-{micro…display}` ·
`type-{label,nav,cta,caption,body,title,heading,display,code}` · `max-w-thread` · `z-{popover…}` ·
`scroll-fade-y` / `scroll-fade-x` (content fades at the edges it can still scroll to; put it on the
scrolling element) · `xray-*` (the X-ray panel surface).

## Theme a surface

```svelte
<script>
	import { ThemeProvider, AppShell } from '@aipotluck/alpha-ds';
</script>

<ThemeProvider mode="dark" persist="alpha:mode">
	<AppShell.Root>…</AppShell.Root>
</ThemeProvider>
```

`ThemeProvider` adds `.ds-root`, a Tooltip provider, and a body-level portal host with the same
theme and mode. Dialogs, Menus and Toasts portal to that host, outside any overflow clipping, and keep
the theme.

## Keep `/designsystem` current

Change the docs in the same commit as the code they describe. See
[Keep the catalog current](docs/ADDING-A-COMPONENT.md#keep-the-catalog-current).
`catalog/registry.spec.ts` fails on an undocumented folder, recipe variant or utility.

## Versioning

The version is derived from the changelog. `changelog/` holds one Markdown entry per change, and
`major.minor.patch` counts the entries of each kind. Semver resets the lower numbers on each bump;
counting doesn't, so two branches that each add an entry reach the same version in either merge
order. The version appears in the `/designsystem` header, on
[`/designsystem/changelog`](/designsystem/changelog), and as the lint plugin's `meta.version`, which
ESLint's `--cache` uses as a key.

After you change the system, record the change:

```bash
pnpm ds:change "Composer.Chip for active tools"   # writes (or updates) this branch's entry
pnpm ds:version                                     # version, latest entries, anything unrecorded
```

`ds:change` compares the public surface (barrel exports, documented parts and props, recipe
variants, tokens, utilities, themes and lint rules) with what the changelog records, and writes the
difference into the entry. The level is `major` when a name was removed, `minor` when one was
added, and `patch` otherwise. Pass `--bump=major` to raise the level. The command never sets a level
lower than the surface change requires. Add notes for other developers below the frontmatter.

`pnpm lint:design` (pre-push and CI) and `version/version.spec.ts` fail when the surface and the
changelog disagree, or when a branch changes design-system source without adding an entry. Changes
to docs, examples and specs don't need an entry. The failure message prints the command to run.

## Lint

`pnpm lint` enforces nine `alpha-ds/*` rules as errors on the design system and every surface built
on it. Five match shadcn/lint, and four are specific to Alpha. `pnpm lint:design` applies a ratchet
to legacy chat code: each file's violation count in `design-lint-baseline.json` can only go down.
[`/designsystem/linting`](/designsystem/linting) has details and examples.

## Commands

```bash
pnpm dev:local                     # dev server on :5199 (auto CMS fallback): /designsystem, /chat, /alpha
pnpm ds:tokens                     # regenerate tokens after editing tokens/*.ts
pnpm ds:change "<summary>"         # record a change; the version follows (see Versioning)
pnpm ds:version                    # current version and anything unrecorded
pnpm lint:design                   # token drift + legacy ratchet (runs in CI)
pnpm lint:design --update          # lock in an improvement (refuses to raise the baseline)
node scripts/ds-lint-ratchet.mjs --report   # where the remaining debt is
pnpm vitest run --project=server-fast ../packages/alpha-ds  # tokens, lint rules, catalog coverage
```

[docs/VERIFYING.md](docs/VERIFYING.md) covers checking a change in a browser.

## Design rules

The full spec is in `web/src/lib/chat/design-system.md`.

- Corners are slightly rounded by default. In the Alpha theme, controls use 4px, cards and menus
  8px, and the composer 10px. Other themes set their own tiers. Use the `field` radius only for the
  composer and prompt examples, and `pill` only for small in-chat calls to action.
- Use the accent colour at icon and badge scale only, never as a surface fill. Destructive buttons
  look like secondary buttons, and only the filled icon uses Accent 2.
- Bordered controls rest one tier up from their surface. Wrap them in `Surface` and the recipes
  handle it.
- Icons come from Remix (`~icons/ri/*`). Line icons use Text 1.
- New UI imports from `@aipotluck/alpha-ds`. If a component can't express what you need, add a
  variant to its recipe. Don't restyle it at the call site (`alpha-ds/no-restyle`).
