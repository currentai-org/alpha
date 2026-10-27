// Strip blank scaffold env keys for `vite-node` harnesses — the counterpart to the
// `scripts/setups/vitest-setup-server.ts` strip, which vite-node never runs (it loads no
// setupFiles).
//
// `web/.env` is a copy of `.env.ci`, which declares every manifest key with an empty value
// (`KEY=`), so Vite injects them into `process.env` as `""` — not undefined. Code that reads
// `process.env.KEY ?? default` (COOP_BLOCK_ACTION_PREFIX, PG_POOL_MAX, the HF_TOKEN `??=`
// fallback, …) then sees `""` and skips the default. Under vitest the setup file above deletes
// these; vite-node runs no setup file, so this import does it. See CUR-142.
//
// This is a SIDE-EFFECT import: putting it FIRST in a vite-node entry deletes the blanks before
// any later import evaluates its own top-level `process.env` reads. Enforced across all vite-node
// package.json entries by src/lib/chat/server/env/harnessBootstrap.spec.ts.
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
try {
	const parsed = dotenv.parse(readFileSync(envPath, "utf-8"));
	for (const [key, value] of Object.entries(parsed)) {
		// Only clear a key that is STILL the blank scaffold value — never wipe a real value set by
		// the shell, the CI job, or .env.local (which Vite layers on top with higher precedence).
		if (value === "" && process.env[key] === "") delete process.env[key];
	}
} catch {
	// No .env present (a fresh checkout that never ran the `.env.ci` -> `.env` copy) — nothing to
	// strip; the keys are simply absent, which is the behaviour we want.
}
