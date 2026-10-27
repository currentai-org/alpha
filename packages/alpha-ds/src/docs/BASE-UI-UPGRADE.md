# Upgrading from Base UI

Base UI is the reference for every component's public shape. When Base UI changes, or when we
adopt a Svelte port as the engine, this is the procedure.

## When Base UI adds or changes a part / prop

1. Open the component's Base UI page (linked from `<name>.docs.ts` → `baseUi.url`, and from the
   component page on `/designsystem`).
2. **New part** → add a sibling `<Part>.svelte`, export it on the namespace in `index.ts`, document
   it in `parts` of the docs file.
3. **New prop** → add it with Base UI's name and default. If the engine lacks it, implement it in
   the wrapper or list it under `deviations` — never silently diverge.
4. **New data attribute** → if recipes need it, add a `ui-*` variant to `tokens/variants.css` that
   matches both Base UI's attribute and the engine's.
5. Update the example(s), then run the checks in ADDING-A-COMPONENT.md.

`deviations` in each docs file are deliberate (e.g. `Tabs.Indicator` folded into `Tabs.Tab` for
brutalist reasons). Read them before "fixing" a difference.

## Swapping the behaviour engine (bits-ui → a Svelte Base UI port)

The engine is only imported by `components/*/*.svelte`. To swap:

1. Per component, replace the `bits-ui` import in its part files with the port's part, keeping the
   wrapper's props, class merging and recipe calls unchanged.
2. `internal/Portal.svelte` and `internal/Positioner.svelte` map to the port's Portal/Positioner
   (the port likely has a real Positioner — the context shim can then pass props straight through).
3. Recipes need no change: `ui-*` variants already match Base UI attributes.
4. Remove `engine` notes that no longer apply in docs files.
5. Run `pnpm probe:design-system` against a dev server — every example and the chat shell are
   exercised in a real browser.
