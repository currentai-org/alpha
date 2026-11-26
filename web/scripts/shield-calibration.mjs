// shield-calibration.mjs — STEP 0 of the Shieldstral swap plan
// (docs/plans/shieldstral-detection-swap.md, "Step 0 — calibration spike").
//
// A standalone threshold-calibration harness for the Shieldstral-1.0-3B judge endpoint. It runs a
// small inline fixture set (per-category red-team text + a benign set) through every category query,
// records the renormalised yes/no logprob score for each, and reports:
//   • per-category score distribution — a category's OWN fixtures vs the benign set on its own query
//   • per-category misses — any category whose own fixtures fail to trip at threshold 0.5
//   • wall-clock timing — the child-only subset of queries and the full category fan-out at the
//     configured concurrency (the gate runs the FULL fan-out on every turn — no umbrella gate)
//
// This is a CALIBRATION harness, not real abuse material. The fixtures are mild, non-graphic
// red-team strings aimed at our OWN policy questions — normal test traffic for a moderation endpoint
// we operate. The child-safety fixtures are deliberately abstract meta-descriptions with NO
// depiction (CSAM is hash-matching's problem, out of this harness's scope). No verdict is
// enforced anywhere; stdout only. This script is text-only and has no image fixtures.
//
// Usage:
//   node scripts/shield-calibration.mjs [GUARD_SHADOW_URL] [--json] [--concurrency N]
//   creds auto-load from web/.env / web/.env.local (HF_TOKEN || OPENAI_API_KEY, HF_BILL_TO).
//   For production creds, run it under your secrets manager's production config.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./lib/loadEnv.mjs";
import { BENIGN_FIXTURES, CATEGORY_FIXTURES } from "./lib/shieldFixtures.mjs";
import { makeShieldJudge } from "./lib/shieldJudge.mjs";

import { validateGuardPolicy } from "../src/lib/chat/server/guardPolicyCore.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");

loadEnv(webRoot, ".env");
loadEnv(webRoot, ".env.local");

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
function argVal(name, def) {
	const i = args.indexOf(name);
	if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
	const eq = args.find((a) => a.startsWith(`${name}=`));
	if (eq) return eq.slice(name.length + 1);
	return def;
}
const concurrency = Math.max(1, parseInt(argVal("--concurrency", "6"), 10) || 6);

const BASE = (args.find((a) => a.startsWith("http")) || process.env.GUARD_SHADOW_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.HF_TOKEN || process.env.OPENAI_API_KEY || "";
const BILL_TO = process.env.HF_BILL_TO || undefined;
const MODEL = "mistralai/Shieldstral-1.0-3B";
const WINDOW = 12000;
const PER_CALL_TIMEOUT_MS = 60000;

if (!BASE) {
	console.error(
		"MISSING GUARD_SHADOW_URL — pass it as an arg or set it in web/.env.local (or use the doppler wrapper)."
	);
	process.exit(2);
}
if (!TOKEN) {
	console.error("MISSING token — set HF_TOKEN or OPENAI_API_KEY in web/.env.local (or use the doppler wrapper).");
	process.exit(2);
}

// ── policy ──────────────────────────────────────────────────────────────────────────────────────
const rules = JSON.parse(readFileSync(resolve(webRoot, "src/lib/chat/server/rules.json"), "utf8"));
const { errors, entries, shield } = validateGuardPolicy(rules);
if (errors.length || !shield) {
	console.error("rules.json invalid — fix before calibrating:", errors);
	process.exit(1);
}

// ── fixtures: scripts/lib/shieldFixtures.mjs ──────────────────────────────────────────────────────

// Self-consistency: every guard-bearing category MUST have fixtures. A category added to rules.json
// without a fixture here is a silent calibration hole — fail loud, do not skip it.
const missingFixtures = entries.filter((e) => !CATEGORY_FIXTURES[e.key] || CATEGORY_FIXTURES[e.key].length === 0);
if (missingFixtures.length) {
	console.error(
		`FIXTURE GAP — these guard categories have no calibration fixtures:\n  ${missingFixtures
			.map((e) => e.key)
			.join("\n  ")}\nAdd a fixture in CATEGORY_FIXTURES before calibrating.`
	);
	process.exit(1);
}

// The query set: every category query (12 for the current rules.json). No umbrella gate — the gate
// runs EVERY category query on every unit, so the calibration matrix is the full category set.
const QUERIES = entries.map((e) => ({
	key: e.key,
	query: e.query,
	tier: e.tier,
	threshold: e.threshold ?? shield.categoryThreshold,
}));
const CHILD_QUERIES = QUERIES.filter((q) => q.tier === "child");

// ── endpoint ──────────────────────────────────────────────────────────────────────────────────────
const judge = makeShieldJudge({
	base: BASE,
	token: TOKEN,
	billTo: BILL_TO,
	instruct: shield.instruct,
	windowChars: WINDOW,
	timeoutMs: PER_CALL_TIMEOUT_MS,
});

// ── concurrency pool ──────────────────────────────────────────────────────────────────────────────
async function runPool(items, worker, poolSize) {
	const results = new Array(items.length);
	let idx = 0;
	async function next() {
		for (;;) {
			const i = idx++;
			if (i >= items.length) return;
			results[i] = await worker(items[i], i);
		}
	}
	await Promise.all(Array.from({ length: Math.min(poolSize, items.length) }, next));
	return results;
}

// ── stats ─────────────────────────────────────────────────────────────────────────────────────────
function stats(scores) {
	const nums = scores.filter((s) => typeof s === "number" && Number.isFinite(s)).sort((a, b) => a - b);
	const missing = scores.length - nums.length; // token / unknown / http-error responses
	if (nums.length === 0) return { n: 0, missing, min: null, max: null, mean: null, median: null };
	const sum = nums.reduce((a, b) => a + b, 0);
	const median =
		nums.length % 2 ? nums[(nums.length - 1) / 2] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
	return { n: nums.length, missing, min: nums[0], max: nums[nums.length - 1], mean: sum / nums.length, median };
}
const fmt = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "  n/a ");

// ── main ────────────────────────────────────────────────────────────────────────────────────────
async function main() {
	const log = (...a) => {
		if (!jsonOut) console.log(...a);
	};
	log(`# shield-calibration  endpoint=${BASE}  model=${MODEL}  concurrency=${concurrency}`);
	log(`categories=${entries.length}  queries=${QUERIES.length}  child=${CHILD_QUERIES.length}`);
	log(`categoryThreshold=${shield.categoryThreshold}\n`);

	// Build the full fixture × query job matrix. Each fixture (unsafe categories + benign) runs against
	// EVERY query, so we can read cross-category leakage as well as own-category trip rates.
	const fixtures = [
		...Object.entries(CATEGORY_FIXTURES).flatMap(([cat, texts]) =>
			texts.map((text, i) => ({ owner: cat, unsafe: true, id: `${cat}#${i}`, text }))
		),
		...BENIGN_FIXTURES.map((text, i) => ({ owner: "benign", unsafe: false, id: `benign#${i}`, text })),
	];
	const jobs = [];
	for (const fx of fixtures) for (const q of QUERIES) jobs.push({ fx, q });

	log(`Running ${jobs.length} judge calls (${fixtures.length} fixtures × ${QUERIES.length} queries)...`);
	const servedModels = new Set();
	const results = await runPool(
		jobs,
		async ({ fx, q }) => {
			const r = await judge(q.query, fx.text, q.threshold);
			if (r.served) servedModels.add(r.served);
			return { fixtureId: fx.id, owner: fx.owner, unsafe: fx.unsafe, queryKey: q.key, tier: q.tier, ...r };
		},
		concurrency
	);

	// Index results by [queryKey][owner] → scores, and by fixtureId for own-query lookups.
	const byQueryOwner = new Map(); // `${queryKey}::${owner}` -> number[]
	const byFixtureQuery = new Map(); // `${fixtureId}::${queryKey}` -> result
	for (const r of results) {
		const k = `${r.queryKey}::${r.owner}`;
		if (!byQueryOwner.has(k)) byQueryOwner.set(k, []);
		byQueryOwner.get(k).push(r.score);
		byFixtureQuery.set(`${r.fixtureId}::${r.queryKey}`, r);
	}
	const scoresFor = (queryKey, owner) => byQueryOwner.get(`${queryKey}::${owner}`) ?? [];

	// ── per-category distribution: own fixtures vs benign, on the category's own query ──────────────
	const CATEGORY_TRIP_THRESHOLD = 0.5;
	const perCategory = [];
	const misses = [];
	for (const e of entries) {
		const own = stats(scoresFor(e.key, e.key));
		const benign = stats(scoresFor(e.key, "benign"));
		perCategory.push({ key: e.key, tier: e.tier, action: e.action, own, benign });
		// A miss = any own fixture whose score on its own query is below 0.5 (or unavailable).
		// A rule with its own `threshold` trips at that, the same value the live gate uses (thresholdFor).
		const trip = e.threshold ?? CATEGORY_TRIP_THRESHOLD;
		const failing = (CATEGORY_FIXTURES[e.key] || [])
			.map((_, i) => {
				const r = byFixtureQuery.get(`${e.key}#${i}::${e.key}`);
				return { id: `${e.key}#${i}`, score: r?.score ?? null, source: r?.source ?? "n/a" };
			})
			.filter((f) => !(typeof f.score === "number" && f.score >= trip));
		if (failing.length) misses.push({ key: e.key, tier: e.tier, threshold: trip, failing });
	}

	// ── timing: the child-only subset and the full category fan-out (the gate runs the full set) ─────
	const timingDoc = BENIGN_FIXTURES[0];
	const childJobs = CHILD_QUERIES; // the child-only subset — a reference point, NOT what a turn runs
	const t0 = Date.now();
	await Promise.all(childJobs.map((q) => judge(q.query, timingDoc, q.threshold)));
	const childMs = Date.now() - t0;

	const t1 = Date.now();
	await runPool(QUERIES, async (q) => judge(q.query, timingDoc, q.threshold), concurrency);
	const fanoutMs = Date.now() - t1;

	// ── identity ────────────────────────────────────────────────────────────────────────────────────
	const servedList = [...servedModels];
	const identityOk = servedList.length > 0 && servedList.every((m) => m.includes(MODEL) || MODEL.includes(m));

	// ── output ──────────────────────────────────────────────────────────────────────────────────────
	if (jsonOut) {
		console.log(
			JSON.stringify(
				{
					endpoint: BASE,
					model: MODEL,
					concurrency,
					servedModels: servedList,
					identityOk,
					categoryTripThreshold: CATEGORY_TRIP_THRESHOLD,
					perCategory,
					misses,
					timing: {
						childSubsetCalls: childJobs.length,
						childSubsetMs: childMs,
						fanoutCalls: QUERIES.length,
						fanoutMs,
						fanoutConcurrency: concurrency,
					},
				},
				null,
				2
			)
		);
		return;
	}

	log(`\n── per-category score distribution (own fixtures vs benign, on the category's own query) ──`);
	log(
		`  ${"category".padEnd(34)} ${"tier".padEnd(8)} ${"act".padEnd(6)}  own[min/med/max]           benign[min/med/max]`
	);
	for (const c of perCategory) {
		log(
			`  ${c.key.padEnd(34)} ${c.tier.padEnd(8)} ${c.action.padEnd(6)}  ` +
				`${fmt(c.own.min)}/${fmt(c.own.median)}/${fmt(c.own.max)}   ` +
				`${fmt(c.benign.min)}/${fmt(c.benign.median)}/${fmt(c.benign.max)}` +
				`${c.own.missing ? `  (own missing=${c.own.missing})` : ""}`
		);
	}

	log(
		`\n── category misses at each rule's threshold (default ${CATEGORY_TRIP_THRESHOLD}; own fixtures that do NOT trip their own query) ──`
	);
	if (misses.length === 0) {
		log(`  none — every category's own fixtures trip at their rule's threshold.`);
	} else {
		for (const m of misses) {
			log(
				`  ⚠ ${m.key} (${m.tier}, threshold ${m.threshold}): ${m.failing.map((f) => `${f.id}=${fmt(f.score)}[${f.source}]`).join(", ")}`
			);
		}
	}

	// `--detail <category>`: every own and benign fixture's score on that category's query, one per
	// line, so a query change can be judged fixture by fixture rather than from min/median/max alone.
	const detailKey = argVal("--detail", "");
	if (detailKey) {
		log(`\n── detail: every fixture on ${detailKey}'s query ──`);
		for (const fx of fixtures.filter((f) => f.owner === detailKey || f.owner === "benign")) {
			const r = byFixtureQuery.get(`${fx.id}::${detailKey}`);
			log(`  ${fmt(r?.score)}  ${fx.id.padEnd(26)} ${fx.text}`);
		}
	}

	log(`\n── timing (warm) ──`);
	log(`  child-only subset, ${childJobs.length} calls (reference point, NOT a whole turn): ${childMs}ms`);
	log(`  full ${QUERIES.length}-query fan-out @ concurrency ${concurrency} (what every turn runs): ${fanoutMs}ms`);

	log(`\n── identity ──`);
	log(
		`  served models: ${servedList.join(", ") || "(none reported)"}  ${identityOk ? "OK" : "⚠ MISMATCH vs " + MODEL}`
	);
}

main().catch((e) => {
	console.error("calibration failed:", e);
	process.exit(1);
});
