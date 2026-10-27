// Build the local Tier-A RAG index: chunk the committed catalog data, embed each
// chunk via the HF Inference feature-extraction endpoint, and write the vectors to
// src/lib/chat/server/rag/data/rag-index.json (committed, so CI/deploys need no key).
//
// Sources (Tier A only — small, curated, already grounding the chat):
//   - categories.json   one chunk per gap-map subcategory (rationale + maturity)
//   - stack-map.json    one chunk per stack node (the live product narrative), serving text left out
//   - projectContext.json the "about AI Potluck" blurb (same file grounding.ts's PROJECT_CONTEXT reads)
//   - policyContext.json  how to delete your data in the product. Never a paraphrase of a published
//                         policy: those pages reach retrieval from the CMS (policyPageSync.ts), and a
//                         hand copy here outranks them while saying something else (CUR-4296)
//
//   node scripts/build-rag-index.mjs            # rebuild the index
//   node scripts/build-rag-index.mjs --entities # rebuild catalog-entities.json from the gap-map DB
//   node scripts/build-rag-index.mjs --check    # assert present, dim-consistent, chunks in sync (CI)
//
// Catalog entities (CUR-888) live in a second file, catalog-entities.json: one chunk per product and
// per organization the site gives a page, each carrying that page's url so a citation links to it.
// They come from the gap-map database (GAP_MAP_DATABASE_URL), not a committed file, because that is
// where the catalog lives now. The June exemplars.json list they replace named 303 repos, of which
// 81 matched a catalog product. Being a database read, they can be stale between rebuilds, and
// --check cannot see that drift; it checks only the file's shape and embedding model. The daily
// .github/workflows/catalog-entities-sync.yml rebuilds it and opens a PR when it changed (inert until
// that workflow reaches main).
//
// --check is offline. That works because chunk TEXT is a pure function of the committed source JSON —
// only the VECTORS need the embedding endpoint. So the check re-derives every chunk from source and
// compares it to what the index holds. Before CUR-74 it only asserted presence / non-empty / dim, none
// of which move when a source doc is edited: the vectors then describe text that no longer exists, and
// that fails OPEN at runtime — no error, just retrieval scoring the wrong phrasings. Same drift guard
// build-guard-vectors.mjs already had.
//
// The embedding request shape mirrors src/lib/chat/server/rag/embed.ts (that module is
// TS and can't be imported here); keep the two in sync.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { orgUrl, productUrl } from "../src/lib/gapmap/entityUrl.ts";
import { countryName } from "../src/lib/gapmap/countryName.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const CATEGORIES = resolve(root, "src/lib/chat/server/textGeneration/data/categories.json");
const PROJECT_CONTEXT = resolve(root, "src/lib/chat/server/textGeneration/data/projectContext.json");
const POLICY_CONTEXT = resolve(root, "src/lib/chat/server/textGeneration/data/policyContext.json");
const STACK_MAP = resolve(root, "static/data/stack-map.json");
const OUT = resolve(root, "src/lib/chat/server/rag/data/rag-index.json");
const ENTITIES_OUT = resolve(root, "src/lib/chat/server/rag/data/catalog-entities.json");

const check = process.argv.includes("--check");
const entities = process.argv.includes("--entities");

// Load .env.local (a personal override layer) FIRST, then .env (the project's base dev secrets —
// HF_TOKEN et al.) as a fallback, so a manual rebuild picks up the embedding model + key from
// wherever a dev keeps them. loadDotEnv only sets a key if it's still unset, so whichever file
// loads first wins — loading .env.local first preserves it as the override layer.
loadDotEnv(resolve(root, ".env.local"));
loadDotEnv(resolve(root, ".env"));

const MODEL = (process.env.RAG_EMBEDDING_MODEL || "sentence-transformers/all-MiniLM-L6-v2").trim();
// A dedicated always-warm endpoint (if configured) is called directly, no /{model}/pipeline suffix —
// mirror embeddingEndpointUrl() in src/lib/server/rag/env.ts; keep the two in sync. The shared
// Inference Providers router needs a token with a specific permission; the dedicated endpoint only
// needs plain bearer access.
const ENDPOINT_URL = (process.env.RAG_EMBEDDING_ENDPOINT_URL || "").trim().replace(/\/$/, "");
const BASE = (process.env.RAG_EMBEDDING_BASE_URL || "https://router.huggingface.co/hf-inference/models")
	.trim()
	.replace(/\/$/, "");
// Prefer the dedicated RAG token (HF_RAG_EMBEDDINGS_TOKEN), falling back to the shared inference
// key — mirror embeddingToken() in src/lib/chat/server/rag/env.ts; keep the two in sync.
const TOKEN = (process.env.HF_RAG_EMBEDDINGS_TOKEN || process.env.OPENAI_API_KEY || process.env.HF_TOKEN || "").trim();
// Optional HF billing org (X-HF-Bill-To) — keep in sync with src/lib/chat/server/rag/embed.ts.
const BILL_TO = (process.env.HF_BILL_TO || "").trim();

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

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

// --- Chunk builders ----------------------------------------------------------

function categoryChunks() {
	if (!existsSync(CATEGORIES)) {
		// Loud, not silent: a stale path here would return [] with no signal, and the index would
		// ship without any category chunks.
		console.error(`build-rag-index: CATEGORIES not found at ${CATEGORIES} — skipping (0 chunks)`);
		return [];
	}
	const cats = readJson(CATEGORIES);
	return cats
		.filter((c) => c && c.id && c.display_name)
		.map((c) => {
			const parts = [
				`${c.display_name} (${c.layer_id ?? "catalog"}).`,
				c.description || "",
				c.parity_rationale || "",
				c.maturity ? `Maturity: ${c.maturity}.` : "",
				typeof c.gap_score === "number" ? `Gap score: ${c.gap_score}.` : "",
			];
			return {
				id: `category:${c.id}`,
				source: "categories",
				title: c.display_name,
				text: parts.filter(Boolean).join(" "),
			};
		});
}

// stack-map.json carries serving tokens ({modelShort}, {servedCheckpoint}, {cscsServingNote},
// {routingProvider}) that servingProvenance.ts fills per render from whichever lane is configured. The
// index is built once, so it has no lane to fill them from, and indexed raw they reached citations as
// "{modelShort} (Model)" (CUR-2138). Which model and host served a turn is known only at answer time,
// and the per-turn provenance facts already carry it, so serving text stays out of the index.
const TEMPLATE_TOKEN = /\{[A-Za-z_]+\}/;

/** Drop each sentence or `;` clause that holds a serving token, keeping the rest of the text. */
const withoutServingClauses = (text) =>
	splitSentences(text)
		.map((sentence) =>
			sentence
				.split(/;\s+/)
				.filter((clause) => !TEMPLATE_TOKEN.test(clause))
				.join("; ")
		)
		.filter(Boolean)
		.map((s) => (/[.!?]$/.test(s) ? s : `${s}.`))
		.join(" ");

/**
 * Exit non-zero when any chunk's title or text still holds a `{token}`. A template nobody filled reads
 * as our own text to the model and shows up raw in the citation strip, so the build refuses it rather
 * than embedding it. Covers both index files, since a citation title can come from either.
 */
function refuseUnfilledTokens(chunks, file) {
	const hits = chunks.filter((c) => TEMPLATE_TOKEN.test(`${c.title ?? ""} ${c.text ?? ""}`));
	if (!hits.length) return;
	console.error(`build-rag-index: ${hits.length} chunk(s) for ${file} hold an unfilled {token}:`);
	for (const c of hits) {
		console.error(`  ${c.id} — ${`${c.title ?? ""} ${c.text ?? ""}`.match(TEMPLATE_TOKEN)[0]}`);
	}
	console.error(
		"\n  Fill it in the source, or drop the clause it sits in (see withoutServingClauses). Text that\n" +
			"  depends on which lane served a turn belongs in the per-turn provenance facts, not the index."
	);
	process.exit(1);
}

function stackMapChunks() {
	if (!existsSync(STACK_MAP)) {
		console.error(`build-rag-index: STACK_MAP not found at ${STACK_MAP} — skipping (0 chunks)`);
		return [];
	}
	const map = readJson(STACK_MAP);
	const chunks = [];
	for (const layer of map.layers ?? []) {
		for (const node of layer.nodes ?? []) {
			// A node NAMED by a token is the serving slot itself (the Model layer's "{modelShort}"). With
			// the serving text gone it is a generic open-weights blurb that would rank top for "Name three
			// well-known open-weight AI models" and make Alpha list itself. The catalog's own product entry
			// describes the model without claiming to serve it.
			if (TEMPLATE_TOKEN.test(node.nm ?? "")) continue;
			const text = [
				`${node.nm ?? node.id} — ${layer.label} layer.`,
				node.org ? `By ${node.org}.` : "",
				node.st ? `Status: ${node.st}.` : "",
				node.d ? withoutServingClauses(node.d) : "",
				node.prov && !TEMPLATE_TOKEN.test(node.prov) ? `Provenance: ${node.prov}.` : "",
			]
				.filter(Boolean)
				.join(" ");
			chunks.push({
				id: `stack:${layer.label}:${node.id}`,
				source: "stack-map",
				title: `${node.nm ?? node.id} (${layer.label})`,
				url: node.url,
				text,
			});
		}
	}
	return chunks;
}

function projectChunk() {
	// Reads the SAME file grounding.ts's PROJECT_CONTEXT loads (data/projectContext.json), so the two
	// cannot drift.
	if (!existsSync(PROJECT_CONTEXT)) {
		console.error(`build-rag-index: PROJECT_CONTEXT not found at ${PROJECT_CONTEXT} — skipping (0 chunks)`);
		return [];
	}
	const ctx = readJson(PROJECT_CONTEXT);
	// RETRIEVAL-ONLY alias prefix (CUR-43). Deictic questions — "what is this site", "who are you" —
	// share no vocabulary with a blurb that opens "AI Potluck is the open, map-grounded chat from
	// Current AI", so they cosine BELOW the floor and retrieve nothing: measured 0.293 against
	// RAG_MIN_SCORE 0.35, while "What is AI Potluck?" scores 0.826. That is not a threshold problem —
	// raising the floor to exclude the false positives has already excluded THIS, and lowering it to
	// admit this admits them. It is a vocabulary gap, so the fix is to give the chunk the words the
	// query actually uses. Measured effect: 0.260 -> 0.370 (over the floor), "What is AI Potluck?"
	// still 0.747, and the off-topic colliders do not move.
	//
	// Deliberately added HERE and not to projectContext.json: that file is also grounding.ts's
	// PROJECT_CONTEXT, i.e. prompt text the model reads aloud, and these aliases are search keys
	// rather than prose. The one-JSON-source rule above still holds for the CONTENT — this prefix adds
	// no facts, so the two copies cannot drift on anything the model would say.
	const ALIASES =
		"This site. This chat. This website. What is this. Who are you. What are you. " +
		"The site you are talking to right now.";
	return [
		{
			id: "project:about",
			source: "project",
			title: ctx.display_name,
			text: `${ALIASES} ${ctx.parity_rationale}`,
		},
	];
}

function policyChunks() {
	// Self-referential facts (retention, training, selling) the model needs to defer to instead of
	// web search — kept as its own small catalog source rather than folded into stack-map.json since
	// these are policy facts, not live stack components. Text is copied from registry.ts's privacy.body
	// default (the actual /chat/privacy page), NOT re-derived, so it can't invent a policy the product
	// doesn't have; re-sync by hand if privacy.body or RETENTION_DAYS changes. Without this source RAG
	// returns null on privacy questions and web search, which cannot see what /chat/privacy says,
	// fills in.
	if (!existsSync(POLICY_CONTEXT)) {
		console.error(`build-rag-index: POLICY_CONTEXT not found at ${POLICY_CONTEXT} — skipping (0 chunks)`);
		return [];
	}
	const facts = readJson(POLICY_CONTEXT);
	// SPLIT, because an unchunked policy document breaks in two ways.
	//
	// Whole, policy.privacy is 1,575 chars and policy.delete-data 994. Every reader clamps a snippet
	// before the prompt (toSnippet, 480 by default, the defense against a federated source returning
	// an unchunked 26 MB blob), so the tail of an authored policy document is silently deleted on its
	// way to the model: "does not sell your data" and "does not use your conversations to train models
	// without your consent" never arrive, and P11/P13 fail.
	//
	// Raising the reader's cap to 1200 instead is worse: with the full policy in context the model
	// answered "do you sell my data" with a bare "[1]" and no prose on 3 of 6 runs, which hedgeGuard
	// then replaces with its sources pointer, an empty answer.
	//
	// Both symptoms come from one cause: a document longer than any reader will show. chunkDocumentText
	// does the same for admin uploads. Split to fit UNDER the reader's clamp and neither symptom has
	// anywhere to occur: nothing is truncated because nothing is oversized, and no single evidence block is large enough to trigger
	// the collapse. Sentence-boundary split so a chunk is never cut mid-claim, which for a policy
	// document is the difference between "we do not sell your data" and "we do".
	//
	// 420 not 480: the reader's clamp is the ceiling, not the target. Leave room for the whitespace
	// collapse toSnippet does before measuring, so a chunk that fits here cannot fail there.
	// `text` is the authored prose ONLY. The synonym list rides in `recallTail`, which splitOversized
	// re-attaches to EVERY piece after splitting: synonyms are a recall device, so each piece needs all
	// of them (a query phrased in one must reach whichever piece holds the answer), and splitting the
	// list across pieces would hand each piece a random third of the phrasings. stripRecallTail drops
	// it again at read, so it costs embedding recall and nothing in the prompt.
	return facts.map((f) => ({
		id: f.id,
		source: "policy",
		title: f.title,
		text: f.text,
		recallTail: f.synonyms?.length ? ` Also relevant to: ${f.synonyms.join(", ")}.` : "",
	}));
}

/** Every chunk the sources currently produce, in build order. Pure — no network, no key. */
// ── Nothing leaves this file longer than a reader will show ─────────────────────────────────────
//
// Every RAG reader clamps a chunk before the prompt (toSnippet, 480 chars — the defense against a
// federated source handing back an unchunked 26 MB blob). A chunk emitted longer than that clamp is
// not "mostly delivered": its tail is deleted silently, and nothing anywhere reports it.
//
// Unsplit, 43 of 101 chunks in the index are over the line. All 40 exemplar membership lists ("Open
// source projects tracked in <cell>: a, b, c…", longest 845) lose their tails, so the catalog answers
// "what is tracked in X" from a cut-off list. Both policy documents lose theirs, so "does not sell
// your data" and "does not use your conversations to train models without your consent" never reach
// the model (P11/P13).
//
// Raising the reader's clamp instead is worse: with the full 1,100-char policy in context the model
// answered "do you sell my data" with a bare "[1]" on 3 of 6 runs. So the chunks come down to the
// reader, not the reader up to the chunks.
//
// 420, not 480: the clamp is the ceiling, not the target. Headroom for toSnippet's whitespace
// collapse means a chunk that fits here cannot fail there.
const MAX_CHUNK_CHARS = 420;

/**
 * Split into sentences at a terminator followed by whitespace; a segment with no terminator (a
 * comma-run list) falls through to `pack`. A split, not a global match: the match form it replaced
 * skipped any text it could not match, so "Mistral Large 3.0 with 41B active" came out as
 * "0 with 41B active" (CUR-888).
 */
const splitSentences = (text) => text.split(/(?<=[.!?])\s+/);

/**
 * Break one chunk's text into pieces that each fit MAX_CHUNK_CHARS, preferring sentence boundaries,
 * falling back to comma boundaries for list-shaped text. Never cuts mid-token.
 *
 * `prefix` is re-emitted at the head of every continuation piece. A catalog entity's description
 * runs past the limit often, and a continuation without the entity's name is a sentence about
 * nobody, which the model then attaches to whatever it retrieved alongside it: the
 * unsourced-property shape rag-exemplar-fabrication.ts exists to catch. The prefix costs a few chars
 * per piece and keeps every piece independently interpretable.
 */
function packText(text, prefix = "") {
	const budget = Math.max(80, MAX_CHUNK_CHARS - prefix.length);
	const units = [];
	for (const sentence of splitSentences(text)) {
		const s = sentence.trim();
		if (!s) continue;
		if (s.length <= budget) {
			units.push(s);
			continue;
		}
		// A single oversized "sentence" is a comma-run list. Split it, keeping the commas.
		let cur = "";
		// Only a comma followed by a space: "8,192 tokens" is a number, not a list boundary.
		for (const part of s.split(/,\s+/)) {
			const p = part.trim();
			if (!p) continue;
			const next = cur ? `${cur}, ${p}` : p;
			if (next.length > budget && cur) {
				units.push(cur);
				cur = p;
			} else {
				cur = next;
			}
		}
		if (cur) units.push(cur);
	}
	const pieces = [];
	let cur = "";
	for (const u of units) {
		const next = cur ? `${cur} ${u}` : u;
		if (next.length > budget && cur) {
			pieces.push(cur);
			cur = u;
		} else {
			cur = next;
		}
	}
	if (cur) pieces.push(cur);
	return pieces.length ? pieces : [text];
}

/** Everything before the first ": " — the "Open source projects tracked in <cell>" label on a list
 *  chunk. Only treated as a prefix when it is short and the remainder is long enough to split. */
function listPrefix(text) {
	const i = text.indexOf(": ");
	if (i < 0 || i > 120) return "";
	return text.slice(0, i + 2);
}

/** Split any chunk the readers would truncate. A chunk already under the bound passes through with
 *  its id untouched, so this is a no-op for the 58 that were always fine. */
function splitOversized(chunks) {
	return chunks.flatMap((c) => {
		const { recallTail = "", ...base } = c;
		const emit = (id, text) => ({ ...base, id, text: `${text}${recallTail}` });
		if (c.text.length <= MAX_CHUNK_CHARS) return [emit(c.id, c.text)];
		const prefix = listPrefix(c.text);
		const body = prefix ? c.text.slice(prefix.length) : c.text;
		const pieces = packText(body, prefix);
		if (pieces.length === 1) return [emit(c.id, c.text)];
		// Same title on every piece: the citation strip shows titles, and a reader checking where a
		// claim came from is not helped by "(2/3)".
		return pieces.map((piece, i) => emit(`${c.id}#${i + 1}`, `${prefix}${piece}`));
	});
}

/**
 * One chunk per catalog product and organization that has a page, with that page's url (CUR-888).
 * "Has a page" is the site's own rule, so a citation never links to a 404: a product needs all three
 * score rows and a known category (the same condition as queries.ts's product count), and every
 * organization except "unknown" gets one (gapMapPayload.ts's listedOrgSlugs).
 */
async function catalogEntityChunks() {
	const url = (process.env.GAP_MAP_DATABASE_URL || "").trim();
	if (!url) {
		console.error("build-rag-index: --entities needs GAP_MAP_DATABASE_URL (doppler run --config prd).");
		process.exit(1);
	}
	const postgres = createRequire(import.meta.url)("postgres");
	const sql = postgres(url, { max: 1 });
	const S = '"os-ai-map"';
	const [products, orgs, [run]] = await sql
		.begin("read only", (tx) =>
			Promise.all([
				tx.unsafe(`
					select p.slug, p.name, p.org, p.org_slug, p.description, k.label as category, k.arc
					from ${S}.products p join ${S}.categories k on k.id = p.category
					where exists (select 1 from ${S}.openness o where o.product_id = p.id)
						and exists (select 1 from ${S}.adoption a where a.product_id = p.id)
						and exists (select 1 from ${S}.capability c where c.product_id = p.id)
					order by p.slug`),
				tx.unsafe(`select slug, display_name, type, country from ${S}.organizations
					where slug <> 'unknown' order by slug`),
				tx.unsafe(`select published_at from ${S}.publish_runs order by published_at desc limit 1`),
			])
		)
		.finally(() => sql.end());

	const namesByOrg = new Map();
	for (const p of products) {
		if (!namesByOrg.has(p.org_slug)) namesByOrg.set(p.org_slug, []);
		namesByOrg.get(p.org_slug).push(p.name);
	}
	const pieces = (id, title, link, prefix, body) =>
		packText(body, prefix).map((piece, i, all) => ({
			id: all.length > 1 ? `${id}#${i + 1}` : id,
			source: "catalog",
			title,
			url: link,
			text: `${prefix}${piece}`,
		}));
	const chunks = [
		...products.flatMap((p) =>
			pieces(
				`product:${p.slug}`,
				p.name,
				productUrl(p.slug),
				`${p.name}${p.org ? ` (by ${p.org})` : ""}, catalog entry under ${p.category}: `,
				(p.description || `${p.name} is listed in the ${p.arc} layer.`).trim()
			)
		),
		// An org with no products has no page to cite (allOrgSlugs() leaves it out, so its link
		// 404s). Since payload contract 2 that includes every steward-only foundation.
		...orgs
			.filter((o) => namesByOrg.has(o.slug))
			.flatMap((o) => {
				const names = namesByOrg.get(o.slug);
				const facts = [
					o.type ? `A ${o.type}` : "An organization",
					o.country ? ` based in ${countryName(o.country)}` : "",
					`, with ${names.length} product${names.length === 1 ? "" : "s"} in the catalog: ${names.join(", ")}.`,
				].join("");
				return pieces(
					`org:${o.slug}`,
					o.display_name,
					orgUrl(o.slug),
					`${o.display_name}, catalog organization: `,
					facts
				);
			}),
	];
	return { chunks, publishedAt: run?.published_at ? new Date(run.published_at).toISOString() : null };
}

function buildChunks() {
	return splitOversized([...categoryChunks(), ...stackMapChunks(), ...projectChunk(), ...policyChunks()]);
}

/**
 * Compare the committed index against the chunks the sources produce RIGHT NOW. Returns a list of
 * human-readable drift lines (empty when in sync). Ordering is deliberately not compared — a reordered
 * source is not stale data, and each chunk carries its own id.
 */
function chunkDrift(indexChunks, sourceChunks) {
	const committed = new Map(indexChunks.map((c) => [c.id, c]));
	const current = new Map(sourceChunks.map((c) => [c.id, c]));
	const drift = [];

	for (const [id, c] of current) {
		if (!committed.has(id)) {
			drift.push(`  + ${id} — in the sources, missing from the index (never embedded)`);
			continue;
		}
		if (committed.get(id).text !== c.text) {
			drift.push(`  ~ ${id} — source text edited since the index was built (vectors are stale)`);
		}
	}
	for (const id of committed.keys()) {
		if (!current.has(id)) drift.push(`  - ${id} — in the index, gone from the sources (orphan vectors)`);
	}
	return drift;
}

// --- Embedding ---------------------------------------------------------------

async function embed(text) {
	const url = ENDPOINT_URL || `${BASE}/${MODEL}/pipeline/feature-extraction`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
			...(BILL_TO ? { "X-HF-Bill-To": BILL_TO } : {}),
		},
		body: JSON.stringify({ inputs: text }),
	});
	if (!res.ok) {
		throw new Error(`embedding failed (${res.status}) for ${url}: ${await res.text()}`);
	}
	const json = await res.json();
	if (Array.isArray(json) && typeof json[0] === "number") return json;
	if (Array.isArray(json) && Array.isArray(json[0])) return json[0];
	throw new Error("unexpected embedding response shape");
}

/** Batched: the entity file is ~1,800 chunks, and one request each is most of the build time. */
async function embedMany(texts) {
	const url = ENDPOINT_URL || `${BASE}/${MODEL}/pipeline/feature-extraction`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
			...(BILL_TO ? { "X-HF-Bill-To": BILL_TO } : {}),
		},
		body: JSON.stringify({ inputs: texts }),
	});
	if (!res.ok) {
		throw new Error(`embedding failed (${res.status}) for ${url}: ${await res.text()}`);
	}
	const json = await res.json();
	if (
		!Array.isArray(json) ||
		json.length !== texts.length ||
		!json.every((v) => Array.isArray(v) && typeof v[0] === "number")
	) {
		throw new Error(`unexpected batch embedding response shape for ${texts.length} inputs`);
	}
	return json;
}

// Five decimals keeps every cosine within 1e-4 of the full-precision one and cuts the entity file
// by about 30% (6.8MB -> 4.8MB at the current catalog size).
const round5 = (v) => v.map((x) => Math.round(x * 1e5) / 1e5);

/**
 * Rebuild catalog-entities.json, embedding only what changed. A chunk whose text matches the
 * committed file's (same embedding model) keeps its vector, and when no chunk's id, title, url or
 * text moved the file is left alone, so the scheduled run (catalog-entities-sync.yml) opens a PR
 * only when the catalog actually changed. Reports `changed` and the counts to GITHUB_OUTPUT.
 */
async function buildEntities() {
	const { chunks, publishedAt } = await catalogEntityChunks();
	refuseUnfilledTokens(chunks, "catalog-entities.json");
	const prev = existsSync(ENTITIES_OUT) ? readJson(ENTITIES_OUT) : null;
	const reusable = new Map(prev?.model === MODEL ? prev.chunks.map((c) => [c.text, c.vector]) : []);
	const key = (c) => `${c.id}\u0000${c.title}\u0000${c.url}\u0000${c.text}`;
	const prevKeys = new Set((prev?.model === MODEL ? prev.chunks : []).map(key));
	const unchanged = prevKeys.size === chunks.length && chunks.every((c) => prevKeys.has(key(c)));
	const prevIds = new Set((prev?.chunks ?? []).map((c) => c.id));
	const ids = new Set(chunks.map((c) => c.id));
	const added = chunks.filter((c) => !prevIds.has(c.id)).length;
	const removed = [...prevIds].filter((id) => !ids.has(id)).length;
	const toEmbed = chunks.filter((c) => !reusable.has(c.text));
	report({ changed: !unchanged, added, removed, reembedded: unchanged ? 0 : toEmbed.length, publishedAt });
	if (unchanged) {
		console.log(`build-rag-index: ${chunks.length} catalog entity chunks, none changed — file left as is ✓`);
		return;
	}

	console.log(
		`build-rag-index: ${chunks.length} catalog entity chunks (publish ${publishedAt}): ` +
			`${added} added, ${removed} removed, ${toEmbed.length} to embed with ${MODEL}…`
	);
	for (let i = 0; i < toEmbed.length; i += 32) {
		const batch = toEmbed.slice(i, i + 32);
		const vectors = await embedMany(batch.map((c) => c.text));
		batch.forEach((c, j) => reusable.set(c.text, round5(vectors[j])));
		console.log(`  embedded ${Math.min(i + 32, toEmbed.length)}/${toEmbed.length}`);
	}
	const out = chunks.map((c) => ({ ...c, vector: reusable.get(c.text) }));
	const dim = out[0]?.vector.length ?? 0;
	const index = { model: MODEL, dim, builtAt: new Date().toISOString(), publishedAt, chunks: out };
	writeFileSync(ENTITIES_OUT, `${JSON.stringify(index, null, 0)}\n`);
	console.log(`build-rag-index: wrote ${out.length} entity chunks (dim ${dim}) -> ${ENTITIES_OUT} ✓`);
}

/** Step outputs for a GitHub Actions caller; a no-op anywhere else. */
function report(fields) {
	if (!process.env.GITHUB_OUTPUT) return;
	const lines = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
	appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

/** Shape and model only: the entity chunks come from a database this check has no access to. */
function checkEntities() {
	if (!existsSync(ENTITIES_OUT)) {
		console.error(
			"build-rag-index: catalog-entities.json missing — run `node scripts/build-rag-index.mjs --entities`."
		);
		process.exit(1);
	}
	const idx = readJson(ENTITIES_OUT);
	const bad = idx.chunks?.find((c) => !Array.isArray(c.vector) || c.vector.length !== idx.dim || !c.url);
	if (!idx.chunks?.length || bad || idx.model !== MODEL) {
		console.error(
			`build-rag-index: catalog-entities.json is unusable (${idx.chunks?.length ?? 0} chunks, model "${idx.model}", ` +
				`first bad chunk ${bad?.id ?? "none"}) — rebuild with --entities.`
		);
		process.exit(1);
	}
	refuseUnfilledTokens(idx.chunks, "catalog-entities.json");
	console.log(
		`build-rag-index: catalog entities OK (${idx.chunks.length} chunks, catalog publish ${idx.publishedAt}). ✓`
	);
}

// --- Main --------------------------------------------------------------------

async function main() {
	if (entities) {
		if (!TOKEN) {
			console.error("build-rag-index: no HF_RAG_EMBEDDINGS_TOKEN / OPENAI_API_KEY / HF_TOKEN found.");
			process.exit(1);
		}
		await buildEntities();
		return;
	}
	if (check) {
		checkEntities();
		if (!existsSync(OUT)) {
			console.error("build-rag-index: index missing — run `npm run build:rag-index`.");
			process.exit(1);
		}
		const idx = readJson(OUT);
		if (!idx.chunks?.length) {
			console.error("build-rag-index: index is empty — run `npm run build:rag-index`.");
			process.exit(1);
		}
		const bad = idx.chunks.find((c) => !Array.isArray(c.vector) || c.vector.length !== idx.dim);
		if (bad) {
			console.error(`build-rag-index: dimension mismatch on chunk ${bad.id}.`);
			process.exit(1);
		}
		// dim alone does NOT identify the model — plenty of models emit 384 dimensions, so vectors from
		// the old model survive every shape assertion above while queries get embedded by the new one.
		// Retrieval degrades to noise with no error, and every threshold tuned against the old vectors
		// (RAG_MIN_SCORE, the CUR-43 cosine bands) silently stops meaning anything.
		if (idx.model !== MODEL) {
			console.error(
				`build-rag-index: model mismatch — index was built with "${idx.model}", RAG_EMBEDDING_MODEL resolves to "${MODEL}".\n` +
					"  Query and document vectors would then come from different models. Rebuild with\n" +
					"  `npm run build:rag-index`, or point RAG_EMBEDDING_MODEL back at the model the index used."
			);
			process.exit(1);
		}
		// The genuine staleness gate (CUR-74). Everything above still passes on an index whose vectors
		// describe deleted or rewritten text — this is the check that can actually see that.
		refuseUnfilledTokens(idx.chunks, "rag-index.json");
		const drift = chunkDrift(idx.chunks, buildChunks());
		if (drift.length) {
			console.error(`build-rag-index: index is STALE — ${drift.length} chunk(s) differ from the sources:`);
			for (const line of drift) console.error(line);
			console.error(
				"\n  The committed vectors describe text that is no longer what the sources say, so retrieval\n" +
					"  scores the wrong phrasings and fails open (no error, just wrong answers).\n" +
					"  Fix: npm run build:rag-index   (needs HF_RAG_EMBEDDINGS_TOKEN / OPENAI_API_KEY / HF_TOKEN)"
			);
			process.exit(1);
		}
		console.log(`build-rag-index: index OK (${idx.chunks.length} chunks, dim ${idx.dim}, in sync with sources). ✓`);
		process.exit(0);
	}

	if (!TOKEN) {
		console.error(
			"build-rag-index: no HF_RAG_EMBEDDINGS_TOKEN / OPENAI_API_KEY / HF_TOKEN found (set one in web/.env.local)."
		);
		process.exit(1);
	}

	const chunks = buildChunks();
	refuseUnfilledTokens(chunks, "rag-index.json");
	console.log(`build-rag-index: ${chunks.length} chunks; embedding with ${MODEL}…`);

	const out = [];
	let dim = 0;
	for (let i = 0; i < chunks.length; i++) {
		const c = chunks[i];
		const vector = await embed(c.text);
		dim = vector.length;
		out.push({ ...c, vector });
		if ((i + 1) % 10 === 0 || i === chunks.length - 1) {
			console.log(`  embedded ${i + 1}/${chunks.length}`);
		}
	}

	const index = { model: MODEL, dim, builtAt: new Date().toISOString(), chunks: out };
	writeFileSync(OUT, `${JSON.stringify(index, null, 0)}\n`);
	console.log(`build-rag-index: wrote ${out.length} chunks (dim ${dim}) -> ${OUT} ✓`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
