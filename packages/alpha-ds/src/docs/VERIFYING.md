# Verify design-system changes

Unit tests check the token math, the lint rules and catalog coverage. For a visual or interaction
change, also check the pages in a browser.

## Run the unit checks

From `web/`:

```bash
pnpm vitest run --project=server-fast ../packages/alpha-ds   # tokens (drift, contrast, spec values), lint rules, catalog coverage
node scripts/ds-tokens.mjs --check
pnpm lint && pnpm lint:design
pnpm check
```

## Check the pages in a browser

Start the dev server with `pnpm dev:local` and open these pages:

- Every `/designsystem/<slug>` page you changed. The preview and its code must render with no
  errors in the console.
- `/chat` and `/alpha`, in light and dark mode, at desktop and mobile widths. The sidebar, thread
  header and composer must render, every button needs an accessible name, and light and dark mode
  must show different surface colours.

### CMS for local runs

`pnpm dev:local` starts the app on port 5199, away from other Vite servers on 5173. The chat layout
reads CMS globals, so every `/chat` route returns 500 (`PayloadFetchError … ECONNREFUSED`) when no
CMS is reachable. The script uses a local Payload on port 3000 when one answers, and the deployed
CMS (read-only content) otherwise. Set `ALPHA_DEV_CMS=local` or `ALPHA_DEV_CMS=remote` to force one,
and `ALPHA_DEV_PORT` to change the port.

`/alpha` and `/designsystem` don't need the CMS.
