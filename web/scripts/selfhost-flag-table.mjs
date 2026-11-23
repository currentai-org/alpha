#!/usr/bin/env node
// Generates the feature-flag table in selfhost/README.md from the registry in flagKeys.ts, so the table
// cannot drift from what the code reads with no PostHog configured (flags.ts, selfHostFlagValue).
//
//   node scripts/selfhost-flag-table.mjs --write   rewrite the table between the markers
//   node scripts/selfhost-flag-table.mjs --check   exit 1 when the README's table is stale (default)
//
// Columns: the flag key, its `selfHost` default, and the env vars that default needs.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FLAG_KEYS, SELF_HOST_CONDITIONS } from "../src/lib/chat/server/flagKeys.ts";

const README = fileURLToPath(new URL("../../selfhost/README.md", import.meta.url));
const BEGIN = "<!-- selfhost-flag-table:begin -->";
const END = "<!-- selfhost-flag-table:end -->";

/** One registry entry as [default, env] cells. */
function cells(spec) {
	const s = spec.selfHost;
	if (s === "on") return ["on", "none"];
	if (s === "off") return ["off", "none"];
	if (s === "code") return [`the code's own fallback (${spec.codeDefault})`, "none"];
	const names = s.onWhenEnv.map((n) => `\`${n}\``).join(", ");
	// Each stand-in condition, in the registry's order, with the env names it stands in for.
	const standIns = Object.entries(s.satisfiedBy ?? {});
	const notes = Object.entries(SELF_HOST_CONDITIONS).flatMap(([condition, describe]) => {
		const covered = standIns.filter(([, c]) => c === condition).map(([n]) => `\`${n}\``);
		return covered.length ? [describe(covered.join(" and "))] : [];
	});
	return ["on when all of its env is set", [names, ...notes].join("; ")];
}

function renderTable() {
	const rows = [...FLAG_KEYS]
		.sort((a, b) => a.key.localeCompare(b.key))
		.map((f) => {
			const [def, env] = cells(f);
			return `| \`${f.key}\` | ${def} | ${env} |`;
		});
	return ["| Flag | Self-host default | Env it needs |", "| --- | --- | --- |", ...rows].join("\n");
}

function withTable(readme, table) {
	const i = readme.indexOf(BEGIN);
	const j = readme.indexOf(END);
	if (i < 0 || j < i) throw new Error(`selfhost/README.md needs ${BEGIN} and ${END} around the flag table`);
	return `${readme.slice(0, i + BEGIN.length)}\n${table}\n${readme.slice(j)}`;
}

const write = process.argv.includes("--write");
const current = readFileSync(README, "utf8");
const next = withTable(current, renderTable());
if (current === next) {
	console.log(`selfhost/README.md flag table is current (${FLAG_KEYS.length} flags)`);
} else if (write) {
	writeFileSync(README, next);
	console.log(`selfhost/README.md flag table rewritten (${FLAG_KEYS.length} flags)`);
} else {
	console.error(
		"selfhost/README.md flag table is stale: run `pnpm selfhost:flag-table:write` in web/ and commit the result"
	);
	process.exit(1);
}
