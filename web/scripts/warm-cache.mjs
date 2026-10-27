#!/usr/bin/env node
/**
 * warm-cache — pre-generate a RESPONSE CACHE for the curated starter (and demo)
 * prompts by driving the REAL app pipeline, so the first answer to a
 * known prompt can be served instantly and survives a flaky connection.
 *
 * This is a cache WARMER, not a hardcoder of answers. Every entry is a genuine model output
 * captured from the live endpoints at generation time — same persona, same grounding,
 * same open-web search, same provenance the app produces at runtime — stamped with the
 * model id and a generatedAt/asOf date so freshness stays honest and the entry is
 * regenerable. Nothing here is hand-authored answer text.
 *
 * The intended serving policy (wired separately, on the streaming seam) is LIVE-FIRST:
 * run live normally, fall back to this cache only when live inference stalls/drops
 * (a poor-connection failure mode). So the cache is a resilience net, not the default.
 *
 * Single source of truth for the starter prompts: src/lib/chat/constants/suggestions.ts
 * (parsed below). Further prompts go in EXTRA_PROMPTS.
 *
 * Usage:   BASE=http://localhost:5173 node scripts/warm-cache.mjs
 * Against a Preview deployment (behind Vercel Deployment Protection / SSO), also set
 * VERCEL_AUTOMATION_BYPASS_SECRET (Project Settings → Deployment Protection → Protection Bypass for
 * Automation; configured for this project) — sent as x-vercel-protection-bypass
 * on every request:
 *   BASE=https://develop.aipotluck.org VERCEL_AUTOMATION_BYPASS_SECRET=... node scripts/warm-cache.mjs
 * Hot-on-deploy: run as a predeploy step against a running instance, commit the artifact.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BASE = (process.env.BASE ?? "http://localhost:5173").replace(/\/$/, "");
const OUT = resolve(ROOT, "static/data/starterCache.json");
const REVIEW_OUT = resolve(ROOT, "static/data/starterCache.review.json");

// `--samples N` is a DIAGNOSTIC: generate N real candidates per prompt and write them to
// a review file (NOT the served cache) so the spread can be eyeballed before serving —
// frozen answers are served repeatedly, so they deserve a best-of look. If the spread has
// weak ones, tune persona/grounding (the admin panel) and re-run; when a single generation
// is reliably good, run with samples=1 to write the served cache. We never hand-pick text
// INTO the served cache (that would be hardcoding) — the loop is tune → warm → review.
function argValue(name, def) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const SAMPLES = Math.max(1, parseInt(argValue("--samples", "1"), 10) || 1);

// ── prompt set ────────────────────────────────────────────────────────────────
// Starters come straight from suggestions.ts (one source of truth). For the search
// starter we also record the DISTILLED query the app would search on (mirrors
// distill.ts) so warmed sources match runtime sources; this is config, not an answer.
function readStarters() {
	const src = readFileSync(resolve(ROOT, "src/lib/chat/constants/suggestions.ts"), "utf8");
	// Find the array LITERAL's "[", not the "string[]" type annotation's — a naive src.indexOf("[")
	// matches the annotation first (it comes first in the file), slicing out an empty "[]" and silently
	// finding zero prompts. "= [" only ever matches the assignment.
	const openIdx = src.indexOf("= [") + 2;
	const block = src.slice(openIdx, src.indexOf("]", openIdx) + 1);
	// Strip // line comments BEFORE pulling string literals — the array spans several lines of
	// explanatory comments between entries, and this file's own comments quote quoted phrases
	// ("current", "open source AI funding in the last month") that a naive whole-block regex picks
	// up as spurious extra "prompts". No prompt here contains "//", so a per-line split is safe.
	const noComments = block
		.split("\n")
		.map((line) => line.split("//")[0])
		.join("\n");
	// pull double-quoted string literals
	return [...noComments.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
}

// Prompts that should warm WITH open-web search, keyed by a substring match, with the
// distilled search query the app would use.
const SEARCH_PROMPTS = [{ match: "EU AI Act", query: "current status of the EU AI Act" }];

// Extra demo prompts to warm; empty until a list is supplied.
const EXTRA_PROMPTS = [];

function searchConfigFor(text) {
	return SEARCH_PROMPTS.find((s) => text.includes(s.match));
}

// ── tiny cookie jar (guest session) ─────────────────────────────────────────────
let cookie = "";
function capture(res) {
	const set = res.headers.getSetCookie?.() ?? [];
	for (const c of set) {
		const kv = c.split(";")[0];
		const name = kv.split("=")[0];
		// replace any prior value for the same cookie name
		const parts = cookie ? cookie.split("; ").filter((p) => p.split("=")[0] !== name) : [];
		parts.push(kv);
		cookie = parts.join("; ");
	}
}
// Preview deployments sit behind Vercel's own Deployment Protection (SSO) — a bare request gets a
// 302 to vercel.com/sso-api regardless of the app's own guest-session cookie. Sending the bypass
// header on every request sidesteps that. NOTE: do NOT also send x-vercel-set-bypass-cookie:true
// here — pairing it with the bypass header on EVERY request (not just once) makes Vercel issue an
// endless "set cookie, redirect back to the same URL" loop (curl -L loops until it hits its redirect
// cap). The bypass header alone is sufficient per-request; no cookie round-trip needed.
const BYPASS = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "").trim();
const H = (extra = {}) => ({
	...(cookie ? { cookie } : {}),
	...(BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {}),
	...extra,
});

const normalize = (t) => t.replace(/\s+/g, " ").trim().toLowerCase();
const keyFor = (text, model) =>
	createHash("sha256")
		.update(`${model}\n${normalize(text)}`)
		.digest("hex")
		.slice(0, 16);

async function parseNdjsonStream(res) {
	if (!res.ok) throw new Error(`message POST ${res.status}: ${await res.text().catch(() => res.statusText)}`);
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buf = "";
	let streamed = "";
	let finalText = null;
	let interrupted = false;
	let errored = null;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += value;
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let u;
			try {
				u = JSON.parse(line);
			} catch {
				continue;
			}
			if (u.type === "stream" && typeof u.token === "string") streamed += u.token;
			else if (u.type === "finalAnswer") {
				finalText = u.text ?? finalText;
				interrupted = Boolean(u.interrupted);
			} else if (u.type === "status" && u.status === "error") errored = u.message ?? "stream error";
		}
	}
	if (errored) throw new Error(errored);
	return { answer: (finalText ?? streamed).trim(), interrupted };
}

// One genuine generation: create a fresh conversation, append the first user turn to its
// root, stream the answer. Returns the real model output (never synthesised).
async function generateOnce(text, modelId, searchContext) {
	const cres = await fetch(`${BASE}/chat/conversation`, {
		method: "POST",
		headers: H({ "content-type": "application/json" }),
		body: JSON.stringify({ model: modelId }),
	});
	capture(cres);
	if (!cres.ok) throw new Error(`create conversation ${cres.status}: ${await cres.text().catch(() => "")}`);
	const { conversationId } = await cres.json();

	// the first user turn appends to the conversation's root (system) message — fetch its id
	const convRes = await fetch(`${BASE}/chat/api/v2/conversations/${conversationId}`, {
		headers: H(),
	});
	if (!convRes.ok) throw new Error(`get conversation ${convRes.status}`);
	const conv = await convRes.json();
	const parentId = (conv.json ?? conv).rootMessageId;
	if (!parentId) throw new Error("no rootMessageId on created conversation");

	// post the message exactly like the client (FormData with a `data` JSON part)
	const form = new FormData();
	form.append(
		"data",
		JSON.stringify({
			inputs: text,
			id: parentId,
			is_retry: false,
			is_continue: false,
			...(searchContext ? { searchContext } : {}),
		})
	);
	const mres = await fetch(`${BASE}/chat/conversation/${conversationId}`, {
		method: "POST",
		headers: H({ origin: BASE }), // SvelteKit CSRF: form posts need a trusted origin
		body: form,
	});
	return parseNdjsonStream(mres);
}

async function main() {
	const starters = readStarters();
	const prompts = [...starters, ...EXTRA_PROMPTS];
	if (!prompts.length) throw new Error("no prompts found to warm");

	// 1. guest session — MUST be under /chat: the site's hooks.server.ts only routes /chat/* through
	// the chat auth/session pipeline (isChatPath), so a bare "/" never sets the guest cookie at all,
	// and /api/v2/models without the /chat prefix is not a route outside the chat subtree either.
	capture(await fetch(`${BASE}/chat`, { headers: H(), redirect: "manual" }));

	// 2. served model id (dynamic — never hardcode the model)
	const modelsRes = await fetch(`${BASE}/chat/api/v2/models`, { headers: H() });
	if (!modelsRes.ok)
		throw new Error(`/chat/api/v2/models ${modelsRes.status} — is the dev server up + guest auth working?`);
	const modelsBody = await modelsRes.json();
	// /api/v2/models is superjson-wrapped ({ json: [...] }); /api/models is a plain array.
	const list = Array.isArray(modelsBody) ? modelsBody : (modelsBody.json ?? modelsBody.models ?? []);
	const served = list.find((m) => !m.unlisted) ?? list[0];
	const modelId = served?.id || served?.name;
	if (!modelId) throw new Error("could not resolve a served model id from /chat/api/v2/models");
	console.log(`model: ${modelId} · prompts: ${prompts.length} · samples: ${SAMPLES} · base: ${BASE}`);

	const entries = {}; // served cache (samples === 1)
	const review = {}; // diagnostic spread (samples > 1)
	for (const text of prompts) {
		const label = text.slice(0, 48).replace(/\s+/g, " ");
		const sc = searchConfigFor(text);
		let searchContext;
		if (sc) {
			// search ONCE per prompt; reused across samples so only the model answer varies
			const sres = await fetch(`${BASE}/chat/api/search?q=${encodeURIComponent(sc.query)}`, {
				headers: H(),
			});
			if (!sres.ok) throw new Error(`/chat/api/search "${sc.query}" → ${sres.status}`);
			const r = await sres.json();
			searchContext = {
				query: r.query ?? sc.query,
				sources: r.sources ?? [],
				evidence: r.evidence ?? "",
				asOf: r.asOf,
			};
			console.log(`  search "${sc.query}" → ${searchContext.sources.length} sources`);
		}

		const sourceMeta = searchContext
			? { sources: searchContext.sources, asOf: searchContext.asOf ?? null, grounded: true }
			: { sources: [], asOf: null, grounded: false };

		const candidates = [];
		for (let i = 0; i < SAMPLES; i++) {
			const { answer, interrupted } = await generateOnce(text, modelId, searchContext);
			if (!answer) throw new Error(`empty answer for "${label}…"`);
			if (interrupted) console.warn(`  ⚠ "${label}…" sample ${i + 1} came back interrupted`);
			candidates.push({ answer, interrupted, chars: answer.length });
			console.log(
				`  ✓ ${label}… sample ${i + 1}/${SAMPLES} (${answer.length} chars${searchContext ? ", grounded" : ""})`
			);
		}

		const key = keyFor(text, modelId);
		const generatedAt = new Date().toISOString();
		if (SAMPLES === 1) {
			entries[key] = {
				prompt: text,
				answer: candidates[0].answer,
				...sourceMeta,
				model: modelId,
				generatedAt,
			};
		} else {
			review[key] = { prompt: text, ...sourceMeta, candidates, model: modelId, generatedAt };
		}
	}

	if (SAMPLES > 1) {
		const reviewArtifact = {
			_note:
				"DIAGNOSTIC ONLY — not served. N real candidate generations per prompt so the spread can be vetted before the demo (frozen answers are served repeatedly). If candidates vary in quality, tune persona/grounding and re-run; when a single generation is reliably good, run `npm run warm-cache` (samples=1) to write the served cache. Never hand-copy text into the served cache.",
			generatedAt: new Date().toISOString(),
			base: BASE,
			model: modelId,
			samples: SAMPLES,
			review,
		};
		writeFileSync(REVIEW_OUT, JSON.stringify(reviewArtifact, null, "\t") + "\n");
		console.log(`\nwrote ${Object.keys(review).length} prompts × ${SAMPLES} candidates → ${REVIEW_OUT}`);
		console.log("(diagnostic only — served cache untouched; run with samples=1 to write it)");
		return;
	}

	const artifact = {
		_note:
			"Warm RESPONSE CACHE: genuine model outputs captured from the live pipeline (persona + grounding + open-web search), not hand-authored demo answers. Served live-first with this as a flaky-connection fallback. Regenerate with `npm run warm-cache`.",
		generatedAt: new Date().toISOString(),
		base: BASE,
		model: Object.values(entries)[0]?.model ?? null,
		keyScheme: "sha256(model + '\\n' + normalized-prompt)[:16]",
		entries,
	};
	writeFileSync(OUT, JSON.stringify(artifact, null, "\t") + "\n");
	console.log(`\nwrote ${Object.keys(entries).length} entries → ${OUT}`);
}

main().catch((e) => {
	console.error("warm-cache failed:", e.message);
	process.exit(1);
});
