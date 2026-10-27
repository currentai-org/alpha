// Pure document-content helpers for federated RAG. LEAF module (no SDK/env/model imports) so it
// loads in the hermetic CI gate and is unit-testable in isolation. Generalized for any SyftHub data
// source.

/** Strip embedded HTML tags and collapse whitespace into a clean one-line snippet. */
export function stripHtml(s: string): string {
	return (s ?? "")
		.replace(/<[^>]+>/g, " ") // drop the HTML some source APIs embed
		.replace(/\s+/g, " ")
		.trim();
}

/** Trim retrieved text to a sentence-ish snippet so the evidence block (and the injected prompt)
 *  stays compact. The single snippet trimmer shared by the local catalog, admin, and federated
 *  SyftHub stores (re-exported from ./rank for the cosine-store call sites) — a federated source can
 *  return a whole un-chunked corpus (seen: a 26 MB document), so every store MUST clamp here before
 *  the text reaches the prompt, or it blows the model's context window. Pure: no model/embed graph. */
export function toSnippet(text: string, max = 480): string {
	const clean = (text ?? "").replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

// ── Prompt-facing field caps (shared across the SyftHub stores) ──────────────────────────────────
// A federated source is not guaranteed to chunk: it can hand back a whole un-chunked corpus as one
// document (seen live: a 26 MB xkcd dump), and an endpoint's NAME / DESCRIPTION / SLUG are equally
// attacker-controlled third-party text. EVERY such field lands verbatim in an injected prompt block —
// so cap the RAW value BEFORE stripHtml (the regex never touches megabytes) and let toSnippet do the
// final clamp. Generous vs the final cap so whitespace collapse can't starve the value, tiny vs a
// multi-MB blob. Lives here (the text-bounding leaf module) so syftSources.ts AND syftCatalog.ts reuse
// one cap discipline instead of duplicating it.
export const RAW_SNIPPET_CAP = 4000;

// ── The CURATED corpora get a different bound, and the reason is who wrote the text ──────────────
// `toSnippet`'s 480 default exists for FEDERATED sources: third-party, unchunked, potentially a 26 MB
// blob, so the clamp is a defense. The local catalog (policyContext.json, baked into rag-index.json)
// and the admin corpus are neither — they are authored here, chunked here, and bounded here. Applying
// the federated defense to them silently deleted the tail of an authored document on its way to the
// model, which is the opposite of what a curated corpus is for.
//
// A clamp at 480 cuts a long chunk mid-sentence. `policy.privacy` is 1,575 chars; clamped at 480 it
// stops at "You can delete all your conversations, saved …", so the model never sees "does not sell
// your data" or "does not use your conversations to train models without your consent" — two of the
// four clauses the behaviour spec grades against — and answers honestly about the 480 chars
// it was handed.
//
// Raising the reader's bound to 1200 is not the fix either: with the full ~1,100-char policy in
// context the model can answer "do you sell my data" with a bare "[1]" and no prose, which hedgeGuard
// replaces with its sources pointer.
//
// So the chunks come down to the reader: build-rag-index.mjs splits anything over 420 chars
// (MAX_CHUNK_CHARS) on sentence, then comma, boundaries. Nothing authored is oversized, so nothing is
// truncated, and no single evidence block is large enough to trigger the collapse. 480 stands as the
// reader's bound for both the federated and the curated stores, and the curated corpus fits inside it.
// curatedSnippetsIntact.spec.ts asserts it keeps fitting.
export const CURATED_SNIPPET_CAP = 480;

// The local index appends a document's `synonyms` to its text as "Also relevant to: …" so the embedding
// picks up phrasings the prose never uses (build-rag-index.mjs). That tail is a RECALL device and is
// noise in the prompt — on `policy.privacy` it is 460 of 1,575 chars, a third of the budget spent
// telling the model a list of ways someone might have asked the question it can already see.
const RECALL_TAIL = /\s*Also relevant to:[^.]*\.\s*$/;

/** Drop the build-appended synonym tail so only authored prose reaches the prompt. No-op on text
 *  that has none (the admin corpus, and any local chunk whose document declared no synonyms). */
export function stripRecallTail(text: string): string {
	return (text ?? "").replace(RECALL_TAIL, "").trim();
}
// Final clamp for the SHORT prompt-facing labels (title, sourceName, endpoint name). mergeRagEvidence
// renders `[n] {title} ({SyftHub:sourceName})` ahead of the snippet, so an un-chunked source could blow
// the prompt via a megabyte title/slug just as easily as via the body — bound these too, not only snippet.
export const LABEL_CAP = 200;

/** Bound a short prompt-facing label (title / source name / endpoint description) from an untrusted
 *  source the same way the snippet is bounded: slice the raw value first (caps regex cost), strip HTML,
 *  clamp to `max` (LABEL_CAP by default; pass a larger cap for a longer prompt-budget field). */
export function capLabel(s: string | undefined, max = LABEL_CAP): string {
	return toSnippet(stripHtml((s ?? "").slice(0, RAW_SNIPPET_CAP)), max);
}

/** Best-effort title/url/snippet extraction from a retrieved document's raw content. Some
 *  federated sources return a JSON article (or an array of them); fall back to the raw text.
 *  Used when a source ships structured JSON in its content field; the Pattern-A path normally
 *  has `SearchDocument.title` directly and only needs {@link stripHtml} on the body. */
export function parseDocContent(
	content: string,
	fallbackTitle = "Source"
): Array<{ title: string; url?: string; snippet: string }> {
	const raw = (content ?? "").trim();
	if (!raw) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [{ title: fallbackTitle, snippet: raw }];
	}
	const items = Array.isArray(parsed) ? parsed : [parsed];
	return items.flatMap((item) => {
		if (!item || typeof item !== "object") {
			return [];
		}
		const o = item as Record<string, unknown>;
		const title = typeof o.title === "string" && o.title ? o.title : fallbackTitle;
		const url = typeof o.url === "string" ? o.url : undefined;
		const snippet = [o.subtitle, o.text_snippet, o.content]
			.map((v) => (typeof v === "string" ? v : ""))
			.find((v) => v.trim());
		return [{ title, url, snippet: snippet ? stripHtml(snippet) : title }];
	});
}
