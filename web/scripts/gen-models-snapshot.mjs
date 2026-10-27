// Build the committed model-catalog boot snapshot: fetch the upstream OpenAI-compatible /models catalog
// ONCE at build time and write it to src/lib/chat/server/data/models-snapshot.json (committed) so a cold
// serverless boot serves the model registry from it INSTANTLY instead of paying the /models round-trip
// in models.ts's top-level await. The live path still refreshes in the background + on drift at runtime
// (see src/lib/chat/server/models.ts §C; kill switch MODELS_BOOT_SNAPSHOT=off).
//
//   node scripts/gen-models-snapshot.mjs
//
// Env resolution MIRRORS src/lib/chat/server/models.ts: primary OPENAI_BASE_URL + OPENAI_API_KEY→HF_TOKEN;
// same-model backup HF_BASE_URL + HF_TOKEN→OPENAI_API_KEY. Wired into `vercel-build` BEFORE the vite
// build. FAIL-SOFT: a fetch failure keeps whatever snapshot already exists (or writes the empty-default
// when none exists) and NEVER fails the build — boot just falls back to the live path.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const OUT = resolve(root, "src/lib/chat/server/data/models-snapshot.json");

// Load .env.local (personal overrides) FIRST, then .env (base dev secrets) as a fallback — same order
// and reason as build-guard-vectors.mjs, so a manual rebuild picks up the base URL + key from wherever
// the dev keeps it. loadDotEnv only sets a key if still unset, so the first file wins (override layer).
loadDotEnv(resolve(root, ".env.local"));
loadDotEnv(resolve(root, ".env"));

const strip = (u) => (u || "").trim().replace(/\/$/, "");
// PRIMARY lane = the configured OPENAI_BASE_URL (the base endpoints are shaped for). Its base is what
// the snapshot records regardless of which lane actually serves the fetch (see below).
const PRIMARY_BASE = strip(process.env.OPENAI_BASE_URL);
const PRIMARY_TOKEN = (process.env.OPENAI_API_KEY || process.env.HF_TOKEN || "").trim();
// BACKUP lane (HF), same as models.ts loadCatalog's fallback — used only if the primary fetch fails.
const FALLBACK_BASE = strip(process.env.HF_BASE_URL);
const FALLBACK_TOKEN = (process.env.HF_TOKEN || process.env.OPENAI_API_KEY || "").trim();
const TIMEOUT_MS = 15_000;

function loadDotEnv(path) {
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (!m) continue;
		const [, k, raw] = m;
		if (process.env[k] === undefined) {
			process.env[k] = raw.replace(/^["']|["']$/g, "");
		}
	}
}

async function fetchCatalog(baseURL, token) {
	const res = await fetch(`${baseURL}/models`, {
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`GET ${baseURL}/models → ${res.status} ${res.statusText}`);
	const json = await res.json();
	const entries = Array.isArray(json?.data) ? json.data : null;
	// Minimal shape check only — models.ts re-validates every entry against the shared zod schema at
	// boot, so a stale-shape snapshot fails there and falls back to the live path regardless.
	if (!entries || !entries.every((e) => e && typeof e.id === "string")) {
		throw new Error(`unexpected /models shape from ${baseURL} (expected data[] of {id})`);
	}
	return entries;
}

function keepExisting(reason) {
	if (existsSync(OUT)) {
		console.warn(`gen-models-snapshot: ${reason} — keeping the existing snapshot at ${OUT}.`);
	} else {
		// No committed snapshot to keep — write an empty-default so the models.ts import always resolves
		// and boot falls back to the live path (parseModelsSnapshot treats empty baseURL/entries as absent).
		writeFileSync(OUT, `${JSON.stringify({ fetchedAt: "", baseURL: "", entries: [] })}\n`);
		console.warn(`gen-models-snapshot: ${reason} — wrote empty-default snapshot (boot uses live path).`);
	}
}

async function main() {
	if (!PRIMARY_BASE) {
		keepExisting("OPENAI_BASE_URL not set");
		return;
	}
	let entries;
	try {
		entries = await fetchCatalog(PRIMARY_BASE, PRIMARY_TOKEN);
	} catch (primaryErr) {
		if (FALLBACK_BASE && FALLBACK_BASE !== PRIMARY_BASE) {
			try {
				entries = await fetchCatalog(FALLBACK_BASE, FALLBACK_TOKEN);
				console.warn(
					`gen-models-snapshot: primary ${PRIMARY_BASE} failed (${primaryErr.message}); used backup ${FALLBACK_BASE}.`
				);
			} catch (backupErr) {
				keepExisting(`both lanes failed (primary: ${primaryErr.message}; backup: ${backupErr.message})`);
				return;
			}
		} else {
			keepExisting(`fetch failed (${primaryErr.message})`);
			return;
		}
	}

	// baseURL ALWAYS records the configured PRIMARY base (even when the backup lane served the fetch) —
	// boot validation compares this against the configured primary used to SHAPE endpoints.
	const snapshot = { fetchedAt: new Date().toISOString(), baseURL: PRIMARY_BASE, entries };
	writeFileSync(OUT, `${JSON.stringify(snapshot)}\n`);
	console.log(`gen-models-snapshot: wrote ${entries.length} entries (baseURL ${PRIMARY_BASE}) → ${OUT} ✓`);
}

main().catch((e) => {
	// FAIL-SOFT: never fail the build. Keep whatever snapshot exists.
	console.warn(`gen-models-snapshot: unexpected error (${e?.message ?? e}); keeping existing snapshot.`);
	process.exit(0);
});
