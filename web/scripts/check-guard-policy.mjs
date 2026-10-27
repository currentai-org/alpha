// check-guard-policy.mjs — the BUILD GATE for the hybrid rules.json guard policy.
//
// Runs the SAME validator the runtime loader and the Vitest spec use (guardPolicyCore.mjs — one
// validator, three consumers). Wired into `vercel-build` so a policy file the guard could not enforce
// (a child rule that only logs, an empty query, a mis-namespaced key, a
// bad _shield block) fails the DEPLOY, not the first production turn.
//
// The runtime loader deliberately does NOT throw at module load — a load-time throw would take the
// Coop path down with it and flag-off could not recover. It maps failure to a loud
// UNKNOWN instead. This gate is where the failure is supposed to be terminal.
//
// Usage:
//   node scripts/check-guard-policy.mjs                 validate src/lib/chat/server/rules.json
//   node scripts/check-guard-policy.mjs --file <path>   validate an alternate file (the injury spec)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { validateGuardPolicy } from "../src/lib/chat/server/guardPolicyCore.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const fileFlag = args.indexOf("--file");
const rulesPath =
	fileFlag !== -1 && args[fileFlag + 1]
		? resolve(process.cwd(), args[fileFlag + 1])
		: resolve(here, "../src/lib/chat/server/rules.json");

let rules;
try {
	rules = JSON.parse(readFileSync(rulesPath, "utf8"));
} catch (e) {
	console.error(`[guard-policy] cannot read/parse ${rulesPath}: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
}

const { errors, entries } = validateGuardPolicy(rules);
if (errors.length > 0) {
	console.error(`[guard-policy] ${rulesPath} failed validation (${errors.length} error(s)):`);
	for (const err of errors) console.error(`  - ${err}`);
	process.exit(1);
}
console.log(
	`[guard-policy] OK — ${entries.length} guard-bearing rule(s) validated (${entries
		.map((e) => `${e.key}=${e.action}/${e.tier}`)
		.join(", ")})`
);
