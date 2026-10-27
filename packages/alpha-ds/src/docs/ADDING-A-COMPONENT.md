# Add a component, primitive or pattern

The catalog, search and coverage test pick up a new entry automatically once it has these five
pieces.

1. **Folder.** Create `components/<name>/` (or `primitives/<name>/`, `patterns/<name>/`) in
   kebab-case. The folder name is the URL slug on `/designsystem`.
2. **Parts.** Add one `.svelte` file per Base UI part, named after the part (`Root.svelte`,
   `Trigger.svelte`, `Popup.svelte`…). Wrap the bits-ui part if one exists. Otherwise, implement it
   natively with the same props. Floating components reuse `internal/Portal.svelte` and
   `internal/Positioner.svelte`. Forward refs to bits-ui with
   `bind:ref={() => ref ?? null, (v) => (ref = v)}` and declare `ref = $bindable()` with no
   fallback.
3. **Skin.** Write `<name>.recipe.ts` with `tv()` from `internal/cn.ts`. Use token utilities only,
   `ui-*` variants for state, and `bg-surface-raised` / `border-line-surface` for anything bordered.
   Parts call `cn(recipe(variants), className)` so a consumer's layout classes merge last.
4. **Entry.** Add an `index.ts` that exports a namespace object (`export const Dialog = { Root, … }`)
   or a single component. Export it from `packages/alpha-ds/src/index.ts` under the matching layer
   heading.
5. **Docs.** Write `<name>.docs.ts`, a `DocEntry` with a description, a `baseUi` link or `null`,
   deviations, anatomy, parts (with props, data attributes and CSS variables) and guidelines. Add at
   least `examples/Hero.svelte`. Examples import from `@aipotluck/alpha-ds` so readers can copy
   their code.

Then run the checks from `web/`:

```bash
pnpm vitest run --project=server-fast ../packages/alpha-ds   # coverage + lint rule tests
pnpm lint:alpha-ds                                           # examples are linted strictly
pnpm check
```

Open `/designsystem/<name>` to review the page.

## Keep the catalog current

Update the docs in the same commit as the code:

- **New or changed prop, variant or part.** Update `<name>.docs.ts`, and an example if the change
  is visible. `registry.spec.ts` fails when a `tv()` variant value is missing from the documented
  prop type.
- **New `@utility` in `tokens/utilities.css`.** Add it to `catalog/foundations/utilities.ts`. The
  spec fails on any utility the Utilities page doesn't list.
- **New token tier or scale entry** (radius, shadow, size). Check that the matching foundation page
  renders it with a real description. Those pages map keys by hand.
- **Reusable piece built in feature code.** When two surfaces use it and it holds no app state,
  move it to `patterns/` with docs and an example. `BentoTile` is an example of a pattern that
  started under `chat/components/`.
- **Any change to design-system source** (a component, recipe, token, utility, theme or lint rule).
  Run `pnpm ds:change "<summary>"`. It writes this branch's changelog entry and sets the bump level
  from the public names you added or removed. `pnpm lint:design` lists unrecorded changes. See
  [Versioning](../README.md#versioning).

## Migrate a legacy surface

1. Replace hand-written markup with components, primitives and patterns. Move colours to token
   utilities.
2. Run `node scripts/ds-lint-ratchet.mjs --report` to list the remaining violations in the file, and
   fix them all.
3. Add the file to `DESIGN_SYSTEM_STRICT` in `web/eslint.config.js`.
4. Run `pnpm lint:design --update` to record the lower baseline.
