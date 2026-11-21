#!/usr/bin/env node
/**
 * eslint-suppressions.json holds the lint hits that predate a rule (ESLint's own --suppress-rule
 * ratchet). ESLint fails on a suppression that no longer matches, but only for files it lints, so an
 * entry for a deleted or moved file would sit there unnoticed. This fails on those.
 *
 *   node scripts/check-eslint-suppressions.mjs          exit 1 if an entry names a file that is gone
 *   node scripts/check-eslint-suppressions.mjs --fix    drop those entries
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(root, "eslint-suppressions.json");
if (!existsSync(path)) process.exit(0);

const suppressions = JSON.parse(readFileSync(path, "utf8"));
const gone = Object.keys(suppressions).filter((file) => !existsSync(resolve(root, file)));
if (gone.length === 0) process.exit(0);

if (process.argv.includes("--fix")) {
	for (const file of gone) delete suppressions[file];
	writeFileSync(path, JSON.stringify(suppressions, null, 2) + "\n");
	console.log(`dropped ${gone.length} eslint-suppressions.json entries for files that no longer exist`);
	process.exit(0);
}

console.error("✗ eslint-suppressions.json names files that no longer exist:");
for (const file of gone) console.error(`  ${file}`);
console.error(
	"\nRun `node scripts/check-eslint-suppressions.mjs --fix`. If a file moved, carry its hits to the new path" +
		" with `pnpm exec eslint --suppress-rule <rule> <new path>`."
);
process.exit(1);
