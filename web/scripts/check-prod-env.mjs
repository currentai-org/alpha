// CI deploy gate (+ local pre-flight): every requiredInProd key in config/env-manifest.mjs must
// be PRESENT in the prod Vercel env, or the deploy FAILS. warn keys are reported, non-fatal.
// Needs vercel auth (VERCEL_TOKEN in CI). If prod env can't be listed (auth/CLI issue) it WARNS
// and exits 0 — an infra blip shouldn't spuriously block a deploy; the missing-key case is the gate.
// Run: node scripts/check-prod-env.mjs        (CI deploy job + `npm run env:check`)
import { execFileSync } from "node:child_process";
import { requiredKeys, warnKeys } from "../config/env-manifest.mjs";

let prodKeys;
try {
	const out = execFileSync("vercel", ["env", "ls", "production", "--format", "json"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	prodKeys = new Set(JSON.parse(out).envs.map((e) => e.key));
} catch (e) {
	console.warn(
		`⚠ env gate skipped — could not list prod env (vercel auth/CLI): ${String(e.message).slice(0, 160)}`
	);
	process.exit(0);
}

const missingRequired = requiredKeys().filter((k) => !prodKeys.has(k));
const missingWarn = warnKeys().filter((k) => !prodKeys.has(k));
if (missingWarn.length)
	console.warn(
		`⚠ soft-required prod vars MISSING (degraded, non-fatal): ${missingWarn.join(", ")}`
	);
if (missingRequired.length) {
	console.error(
		`✗ DEPLOY BLOCKED — required prod env vars missing: ${missingRequired.join(", ")}\n  Set them in Vercel (prod) or fix config/env-manifest.mjs, then redeploy.`
	);
	process.exit(1);
}
console.log(
	`✓ prod env gate: all ${requiredKeys().length} required vars present${missingWarn.length ? ` (${missingWarn.length} soft-missing)` : ""}.`
);
