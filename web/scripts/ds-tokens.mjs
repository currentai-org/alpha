#!/usr/bin/env node
/**
 * Regenerate the Alpha design-system token outputs from their TS sources.
 *
 *   pnpm ds:tokens          write generated/tokens.css + generated/tokens.json
 *   pnpm ds:tokens --check  exit 1 if the checked-in files differ (CI / pre-push)
 *
 * Sources: packages/alpha-ds/src/tokens/{scales,themes}.ts. Node imports them directly (type
 * stripping), so there is no separate build step and no second copy of the logic.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCss, buildDtcg, buildManifest, buildTailwind } from "../../packages/alpha-ds/src/tokens/build.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "../packages/alpha-ds/src/tokens/generated");
// Output is deterministic by construction (no formatter in the loop), and the folder is in
// .prettierignore, so `--check` compares exactly what build.ts produces.
const outputs = [
	["tokens.css", buildCss()],
	["tailwind.css", buildTailwind()],
	["manifest.json", buildManifest()],
	["tokens.json", JSON.stringify(buildDtcg(), null, "\t") + "\n"],
];

const check = process.argv.includes("--check");
let drift = false;
for (const [name, text] of outputs) {
	const path = resolve(outDir, name);
	let current = "";
	try {
		current = readFileSync(path, "utf8");
	} catch {
		// Not generated yet: an empty `current` reads as stale, which is the right answer.
	}
	if (current === text) continue;
	if (check) {
		console.error(`✗ ${name} is stale — run \`pnpm ds:tokens\``);
		drift = true;
	} else {
		writeFileSync(path, text);
		console.log(`✓ wrote ${name}`);
	}
}
if (drift) process.exit(1);
if (check) console.log("✓ design tokens up to date");
