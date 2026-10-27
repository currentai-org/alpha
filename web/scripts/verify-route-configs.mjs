// Tripwire for a per-route `export const config` (e.g. `{ maxDuration: 60 }`): an INVISIBLE
// COUPLING that changes `@sveltejs/adapter-vercel`'s function layout, which can drop routes from
// the catchall manifest and make every `/chat/*` answer "Page /chat/... not found". No other lint
// or test catches it. The codebase documents the ban in prose (see
// src/routes/tuning/rag/upload/+server.ts) — this makes the prose a hard, deterministic gate.
//
// If a route GENUINELY needs a non-default timeout/runtime/region, set it adapter-globally in
// svelte.config.js (the Vercel default function timeout is 300s — ample for our routes),
// never per-route. See the deploy runbook.
//
//   npm run verify:route-configs   # exit 1 if any route file exports `const config`
//
// Pure, no network, no build needed — greps source. Comment lines (`// export const config…`,
// the existing "NO per-route config here" notes) are NOT matches; only real export statements.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES = resolve(here, "../src/routes");

/** Recursively collect SvelteKit route module files (+page/+server/+layout, .ts/.js). */
function routeFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = resolve(dir, name);
		if (statSync(full).isDirectory()) out.push(...routeFiles(full));
		else if (/^\+(page|page\.server|server|layout|layout\.server)\.(ts|js)$/.test(name)) out.push(full);
	}
	return out;
}

// A real export statement at the start of a (trimmed) line. `//`-prefixed lines are comments
// and never match. We intentionally don't try to parse block comments — none wrap these exports
// in this codebase, and a false positive here is loud and easy to clear.
const EXPORT_CONFIG = /^\s*export\s+const\s+config\b/;

const offenders = [];
for (const file of routeFiles(ROUTES)) {
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, i) => {
		if (EXPORT_CONFIG.test(line))
			offenders.push({
				file: file.replace(`${ROUTES}/`, "src/routes/"),
				line: i + 1,
				text: line.trim(),
			});
	});
}

// Checked here because this script runs FIRST in `vercel-build`, and the build log is the durable
// per-deployment record — the one surface that can answer "what did THIS deployment actually run on"
// weeks later, when prod-logs.sh has kept nothing and `vercel inspect` reports the project's floating
// "24.x" rather than a version. The reasoning, the directions and what this cannot see all live in
// node-pin.mjs's header.
//
// This stays a PRINT, deliberately. `verify:route-configs` also runs in CI and in `ci:local` (so on
// every push, from a dev box that may sit below the pin), and a lower Node there is the fail-safe
// direction — it rejects a superset of what the deploy would. Enforcement belongs only where the
// running Node IS the deploy target's, which is check-node-pin.mjs, wired into `vercel-build` alone.
console.log(
	`verify-route-configs: node ${process.version} (web/.nvmrc pins ${readFileSync(resolve(here, "../.nvmrc"), "utf8").trim()}; enforced for deploy builds by check-node-pin.mjs)`
);

if (offenders.length === 0) {
	console.log("verify-route-configs: OK — no per-route `export const config` in any route file.");
	process.exit(0);
}

console.error("verify-route-configs: FAIL — per-route `export const config` found (it breaks the function layout).");
for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.text}`);
console.error(
	"\n  A per-route config silently splits adapter-vercel's function layout and can drop routes from the\n" +
		"  catchall manifest → /chat/* 500s. Set timeouts/runtime/regions adapter-GLOBALLY in svelte.config.js\n" +
		"  instead (Vercel default timeout is 300s). See the deploy runbook."
);
process.exit(1);
