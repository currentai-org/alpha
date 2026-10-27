# Architecture and decisions

Each section records one decision that shapes the design system.

## 1. Base UI anatomy, bits-ui behaviour

**Decision.** Every component follows Base UI's public shape: namespace and part names
(`Popover.Root/Trigger/Portal/Positioner/Popup/Arrow`), prop names (`open`, `value` as an array for
Accordion and ToggleGroup, `keepMounted`, `hiddenUntilFound`) and data-attribute names. The
behaviour engine underneath is bits-ui, a Svelte 5 library the app already depends on.

**Reason.** Upgrades start from base-ui.com, and matching names make the mapping mechanical. bits-ui
provides accessibility, focus management and floating positioning, so the design system doesn't
implement them.

**Alternatives considered.** `base-ui-svelte`, an unofficial port, isn't mature enough yet.
[BASE-UI-UPGRADE.md](BASE-UI-UPGRADE.md) describes how to swap engines when a port is ready. A
custom headless layer would cost more and add accessibility risk.

**Boundary.** `bits-ui` is imported from `components/*/*.svelte` and from no recipe, pattern, lint
rule or consumer. Each `<name>.docs.ts` records the engine part used for each Base UI part
and lists deliberate deviations.

## 2. State styling through `ui-*` variants

Recipes style state with `ui-open:`, `ui-checked:`, `ui-highlighted:` and similar variants, defined
in `tokens/variants.css`. Each variant matches both Base UI's attribute (`[data-open]`) and bits-ui's
(`[data-state="open"]`). Recipes use Base UI's names, so they need no change when the engine is
swapped.

## 3. Colour: seeds, OKLCH ladder, `light-dark()`

- **Seeds.** A theme is about 12 inputs in `tokens/themes.ts`. `color/derive.ts` expands them into
  about 30 semantic tokens per mode. Surface tiers come from OKLCH lightness offsets (darker sinks,
  lighter floats). Text tiers step toward the background and are then solved for contrast. Each
  accent and status colour gets a separate text-safe variant, plus alpha rules and tints.
- **OKLCH output.** Hex is accepted as input only. OKLCH gives perceptually even steps and
  predictable lightness, and current browsers support `oklch()` natively.
- **`light-dark()` and `color-scheme`.** Each token is one declaration, and the mode is the
  `color-scheme`. Rendering needs no JavaScript, `system` mode follows the OS, and any subtree can
  switch mode, as the footprint card and the dark chrome bar do. Tokens that hold `light-dark()`
  resolve where they're used, against that element's scheme.
- **Checked-in outputs with a drift test.** `pnpm ds:tokens` writes the CSS, the Tailwind bridge, a
  DTCG JSON file (for Figma and Tokens Studio) and the lint manifest. `tokens.spec.ts` rebuilds the
  outputs in memory and fails on drift. It also checks the contrast targets and the spec's fixed
  values (#181818, #121212 and #2F2F2F, and white rules at 10, 30 and 50%).

Move derivation into CSS once `contrast-color()` or relative-colour contrast solving is reliable in
browsers.

## 4. Surface context

Some placement rules depend on what's behind an element, such as "bordered buttons rest one tier up"
and "Border 3 on Background 3". `data-surface="1|2|3|chrome"` sets `--ds-surface`,
`--ds-surface-raised` and `--ds-surface-line` for descendants, and recipes read those variables.
Components follow the rules without knowing where they render. `Surface` is the only primitive that
sets a tier.

## 5. Tailwind as the styling language

The generated `@theme inline` block turns tokens into Tailwind v4 utilities that remain live CSS
variables. Tailwind is already the app's styling layer. `internal/cn.ts` extends tailwind-merge with the token names, so
`text-body` (a size) never overrides `text-fg-2` (a colour). Recipes use `tailwind-variants`. Each
component has one recipe file that holds every visual decision for it.

## 6. Documentation by convention

The docs contract is `<layer>/<slug>/<slug>.docs.ts` plus `examples/*.svelte`, and the registry finds
them by glob. The code shown on `/designsystem` is the example file's own source (`?raw`), so the
preview and the code always match. `catalog/registry.spec.ts` fails when a folder lacks docs, an
example or an index.

## 7. Strict lint with a ratchet

`web/eslint-rules/alpha-ds/` defines nine rules:

- Five match shadcn/lint: `no-raw-colors`, `no-arbitrary-values`, `no-inline-styles`, `no-restyle`
  and `require-static-classes`.
- Four are specific to Alpha: `no-legacy-tokens`, `no-unknown-tokens`, `no-off-scale` and
  `remix-icons-only`.

The rules report errors on the design system and on migrated surfaces (`DESIGN_SYSTEM_STRICT` in
`eslint.config.js`). Legacy chat code is held to a per-file, per-rule ratchet (`pnpm lint:design`,
run in CI). Each rule has tests that show it fires on the violation it names.

## 8. Legacy bridge

`tokens/legacy-bridge.css` maps about 1,500 `var(--ap-*)` reads, the grey ramp and the shadcn
variables to tokens inside `.ds-root`. Unmigrated chat code therefore takes the current theme and
follows light and dark mode. The lint reports every legacy read. Delete the file when the ratchet
reaches zero.
