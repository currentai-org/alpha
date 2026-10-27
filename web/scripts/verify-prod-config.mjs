#!/usr/bin/env node
// verify-prod-config — assert a deployed environment serves the config we committed to serving.
// Exits non-zero when what prod does and what config/prod-config-expectations.json says diverge.
//
// WHY. PUBLIC_SEARCH_TRIGGER can hold "" in Doppler prd, and resolveTriggerStrategy maps anything
// outside heuristic|model|tool|margin to the code default (triggerStrategy.ts:49). The margin gate
// can then have a validated strategy, a tunable threshold and an eval suite while production runs
// the recency regex, with nothing able to complain. env:audit compares key PRESENCE and the key is
// present; the manifest checks presence and never values by design (env-manifest.mjs); the strategy
// has a prod-safe code default, which is the right shape and is also what makes the failure quiet.
//
// That is the "built and tested ≠ enabled" split: the enable decision has no natural trigger, so
// nothing notices when it is missing.
//
// RUNS OFF OUR INFRASTRUCTURE, like synthetic-turn.mjs and for the same reason: a probe inside the
// thing it tests is silenced when that thing is down. It is also NOT sufficient to gate this at deploy time —
// pushing to main auto-deploys and promotes without running deploy-prod.sh at all.
//
// TWO ASSERTIONS, deliberately different failures:
//
//   1. WHICH strategy is served — read from the layout payload, no auth needed.
//   2. Whether margin's gate is actually the one deciding — only when margin is the expectation.
//      The classify route reports `decider` and `fallback` (CUR-2108). With the embedding gate
//      flagged off or failing, shouldRunSearch searches every such turn (triggerStrategy.ts,
//      CUR-2109), so the gate reads as configured-on while deciding nothing. Assertion 1
//      alone would report green through that.
//
// Usage:  node scripts/verify-prod-config.mjs --env production [--base URL] [--chat-path /chat|/] [--expect margin]
//         --expect overrides the committed strategy. It exists to PROVE this check goes red without
//         having to break production first; it is not for making a real mismatch pass.

import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ENV = arg("env", "production");
const TIMEOUT_MS = Number(arg("timeout", "30000"));
const CLASSIFY_PROBE = "latest AI news today";

// `die` is the single exit path for both a genuine config-drift finding (servedStrategy
// mismatch, a margin decider check that failed) and the probe simply not reaching one (network
// error, non-2xx, the SvelteKit payload shape having moved, no expectations for --env). `kind: "drift"` marks the genuine-finding call sites
// only; its absence is what the alert step reads as "the probe itself failed" (CUR-1427).
const GH_OUTPUT = process.env.GITHUB_OUTPUT;
const die = (msg, kind) => {
	console.error(`✖ prod-config FAILED [${ENV}]: ${msg}`);
	if (kind === "drift" && GH_OUTPUT) appendFileSync(GH_OUTPUT, "drift=true\n");
	process.exit(1);
};

const EXPECTATIONS = JSON.parse(
	readFileSync(new URL("../config/prod-config-expectations.json", import.meta.url), "utf8")
);
// An env block is one that names a strategy. Only those are candidate envs, so a non-env block added
// later is never offered in the error to the next person debugging a typo'd --env.
const isEnvBlock = (v) => v && typeof v === "object" && "searchTriggerStrategy" in v;
const expected = isEnvBlock(EXPECTATIONS[ENV]) ? EXPECTATIONS[ENV] : undefined;
if (!expected) {
	die(
		`no expectations for env "${ENV}" — known: ${Object.keys(EXPECTATIONS)
			.filter((k) => isEnvBlock(EXPECTATIONS[k]))
			.join(", ")}`
	);
}

const BASE = (arg("base", expected.baseUrl) ?? "").replace(/\/+$/, "");
if (!BASE) die(`no --base given and no baseUrl committed for "${ENV}"`);
// Where chat's pages live on BASE: "" on a chat-surface host, which serves chat at its root (alpha,
// CUR-4448), "/chat" on a site-surface one (develop, a preview). The env block's `chatPath` says which;
// `--chat-path` overrides it for a --base of the other kind, and "/" there means the root. The API keeps
// its /chat/api prefix on both, so only the page payload below reads this.
const CHAT_PATH = arg("chat-path", expected.chatPath ?? "/chat").replace(/\/+$/, "");

const expectedStrategy = arg("expect", expected.searchTriggerStrategy);
if (!expectedStrategy) die(`expectations for "${ENV}" name no searchTriggerStrategy`);

const fetchOrDie = async (url, init, what) => {
	let res;
	try {
		res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch (e) {
		// Unreachable is a HARD failure, never a pass — env-drift.mjs's rule. A check that treats "I
		// could not look" as "nothing is wrong" is the thing this file exists to stop shipping.
		die(`could not reach ${what} at ${url} — ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!res.ok) die(`${what} returned HTTP ${res.status} (${url})`);
	return res;
};

// ── 1. Which strategy is served ────────────────────────────────────────────────────────────────
//
// <chat path>/__data.json is SvelteKit's serialization of the same layout load the page SSRs, served
// unauthenticated. Two shape details, both load-bearing and both verified against prod rather than
// assumed: the body is NDJSON (deferred promises stream as later lines), so JSON.parse of the whole
// response throws; and devalue encodes the payload as a flat array whose element 0 maps keys to
// indices into it, with -1 reserved for undefined.
const DATA_URL = `${BASE}${CHAT_PATH}/__data.json`;
const dataRes = await fetchOrDie(DATA_URL, {}, "the layout data payload");
const body = await dataRes.text();

// A parse failure here means the SURFACE moved, not that config is wrong. Different fix, so it gets
// a different message — the two reds must not read the same in an alert.
const moved = (why) =>
	die(`could not read the SvelteKit data payload (${why}). The surface may have moved — this is a
   broken probe, not a config mismatch. Re-derive the shape from ${DATA_URL}.`);

let payload;
try {
	payload = JSON.parse(body.split("\n")[0]);
} catch (e) {
	moved(e instanceof Error ? e.message : String(e));
}

// Find the node that actually carries the key rather than the first data node. A root
// +layout.server.ts added later would prepend a node and silently shift a positional read.
const nodes = (payload?.nodes ?? []).filter((n) => n && n.type === "data" && Array.isArray(n.data));
const carrying = nodes.filter((n) => n.data[0] && "searchTriggerStrategy" in n.data[0]);
if (carrying.length !== 1) {
	moved(`expected exactly one data node carrying searchTriggerStrategy, found ${carrying.length}`);
}

const deref = (node, key) => {
	const i = node.data[0][key];
	if (i === undefined) moved(`key "${key}" is absent from the payload`);
	// devalue writes -1 for undefined. Without this, a field that silently stopped being populated
	// would deref to whatever sits at index -1 (nothing) and read as a pass on a missing value.
	if (i === -1) moved(`key "${key}" is present but undefined in the payload`);
	return node.data[i];
};

const servedStrategy = deref(carrying[0], "searchTriggerStrategy");
if (typeof servedStrategy !== "string") {
	moved(`searchTriggerStrategy is ${typeof servedStrategy}, expected a string`);
}
if (servedStrategy !== expectedStrategy) {
	die(
		`search-trigger MISMATCH — serving "${servedStrategy}", expected "${expectedStrategy}".\n` +
			`   Three things have to be true and they fail independently: (1) Doppler holds it, Encrypted —\n` +
			`   a Sensitive PUBLIC_ var reads undefined. (2) VERCEL holds it — check with \`vercel env pull\`,\n` +
			`   NOT \`vercel env ls\`, whose age column is labelled "created" and therefore never moves when\n` +
			`   a value is UPDATED, so it cannot show whether the Doppler sync delivered. (3) The deployment was BUILT\n` +
			`   after (2) — Vercel binds env at build time. (3) is the usual cause and a redeploy is the fix.\n` +
			`   If "${servedStrategy}" is now intended, that belongs in config/prod-config-expectations.json.`,
		"drift"
	);
}

const servedIsAdmin = deref(carrying[0], "isAdmin");
if (servedIsAdmin !== expected.isAdmin) {
	die(`isAdmin is ${JSON.stringify(servedIsAdmin)} on an ANONYMOUS request, expected ${expected.isAdmin}`, "drift");
}

console.log(`✓ ${BASE} serves searchTriggerStrategy="${servedStrategy}", isAdmin=${servedIsAdmin}`);

// ── 2. Is the margin strategy's gate actually the one deciding? ─────────────────────────────────
//
// Only meaningful under margin. Its gate is the embedding gate now (CUR-2108; the logprob gate it
// replaced is deleted), and the failure this leg names is the regex deciding in the gate's place —
// the flag off, the embedder uncalibrated, or the embedding call failing — while config says margin.
//
// IF YOU ADD A GATED ASSERTION HERE, PROVE IT RED WITH ITS GATE OPEN. A red-proof run while the
// gate below returns early exercises assertion 1 only, so "I proved the check can go red" is true
// of the file and false of the leg. A check must go red for the failure it NAMES; the corollary a
// gate adds is that the proof has to run the same branch the deploy will.
if (expectedStrategy !== "margin") {
	console.log(`  (decider check skipped — only asserted when the expectation is "margin")`);
	process.exit(0);
}

// No cookie needed: requireAuth establishes the session server-side without one echoed back, and
// classify answers an uncredentialed GET ({"shouldSearch":true,"ok":true} on the develop preview,
// CUR-2108). Harvesting Set-Cookie from GET /chat/ cannot work: it 308-redirects to /chat, and
// handle.ts:231-234 only calls refreshSessionCookie on POST or login paths, so no GET of any chat
// URL sets a cookie. A hard failure on a missing cookie would fail every prod deploy, and
// deploy-prod.sh would read that as a bad deployment and revert it.
const classifyUrl = `${BASE}/chat/api/search/classify?q=${encodeURIComponent(CLASSIFY_PROBE)}`;
const clsRes = await fetchOrDie(classifyUrl, {}, "the classify endpoint");
const cls = await clsRes.json();

// `decider` is on every response since CUR-2108. Its ABSENCE means a deployment older than that;
// a value other than "embedding" means margin is not what is deciding; `fallback` means the gate ran
// and gave no verdict, so the turn searched regardless.
if (!("decider" in cls)) {
	die(
		`classify returned ${JSON.stringify(cls)} with no "decider" field — expect a stale deployment\n` +
			`   serving code from before CUR-2108.`,
		"drift"
	);
}
if (cls.decider !== "embedding" || cls.fallback) {
	die(
		`classify returned decider=${JSON.stringify(cls.decider)} fallback=${JSON.stringify(cls.fallback)} —\n` +
			`   the embedding gate is not deciding, so every automatic turn searches while\n` +
			`   config claims margin. "embedding-gate-off" means the search-intent-embedding-gate flag is off.`,
		"drift"
	);
}

console.log(`✓ embedding gate deciding: classify(${JSON.stringify(CLASSIFY_PROBE)}) → ${JSON.stringify(cls)}`);
