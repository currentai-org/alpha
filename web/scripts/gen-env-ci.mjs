// Regenerate .env.ci from config/env-manifest.mjs (the single source of truth).
// .env.ci is the CI type-scaffold svelte-check needs; key presence only, values empty.
// Run: npm run env:gen   (after adding/removing a key in the manifest).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { allKeys } from "../config/env-manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const header = `# .env.ci — GENERATED from config/env-manifest.mjs by scripts/gen-env-ci.mjs. DO NOT EDIT BY HAND.
# CI type-scaffold for svelte-check (npm run check): svelte-kit sync narrows $env/dynamic/* to these
# keys. Values are intentionally empty — KEY PRESENCE ONLY, not runtime values.
# Hermetic tests (scripts/setups/vitest-setup-server.ts) keep blank keys off process.env so
# \`??\` / unset-default semantics still work; real values come from the CI job env or a local .env.
# Add a config.X key the code reads -> add it to config/env-manifest.mjs -> run \`npm run env:gen\`.
`;
const body = allKeys()
	.map((k) => `${k}=`)
	.join("\n");
writeFileSync(join(root, ".env.ci"), `${header}\n${body}\n`);
console.log(`regenerated .env.ci with ${allKeys().length} keys`);
