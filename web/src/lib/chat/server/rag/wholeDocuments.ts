// The model reads a cited document whole (CUR-4296). Given three 480-character chunks of a 30-chunk
// Privacy Notice, a model answers as if those three were the whole policy. Retrieval picks which document
// is relevant; this module then hands the model that document's full text from the same store,
// within a per-turn budget ("small-to-big" retrieval).
//
// It reads the admin store's own rows, never the source the document came from. Every document gets
// the same treatment whether a CMS publish synced it (policyPageSync.ts) or an admin uploaded it, and
// the turn opens no new path to the CMS.
//
// The document text goes into the prompt only. The persisted source keeps its short snippet, so a
// message row does not carry a copy of the document.

import { sql } from "drizzle-orm";
import type { RagSource } from "$lib/chat/types/Rag";
import { getDb } from "$lib/chat/server/db/client";
import { logger } from "$lib/chat/server/logger";
import { withTimeout } from "./evidence";
import { embeddingModel } from "./env";

/** Total document text one turn may add to the prompt. The policy pages are about 12k, 9k and 8k
 *  characters, so the top page always fits and a second usually does; about 5k tokens, against the
 *  32k context floor of the smallest offered lane (harnessProfiles.ts). */
const WHOLE_DOCUMENT_BUDGET_CHARS = 20_000;

/** How long the turn waits on the read before answering from the chunks instead. */
const WHOLE_DOCUMENT_READ_MS = 2_000;

/** Source types read whole at any length, up to the budget: a policy is answered from all of it, since
 *  an exception or definition three sections away changes what a sentence means. "cms-page" is what
 *  policyPageSync.ts writes; an admin uploading a policy from anywhere else gives it "policy". */
const ALWAYS_WHOLE_SOURCE_TYPES: readonly string[] = ["cms-page", "policy"];

/** Any other document is read whole only up to this length. Past it a document is usually an explainer
 *  covering many topics (About AI Potluck is 17.5k characters), and a question about one of them would
 *  carry the rest as same-subject text the answer does not need. Such a document keeps its chunks. */
const SHORT_DOCUMENT_CHARS = 6_000;

type Hit = Omit<RagSource, "n">;

type StoredDocument = { text: string; sourceType: string | null };

/** Reads each document's full text from its active chunks; an id it cannot read is absent. */
export type DocumentReader = (documentIds: string[]) => Promise<Map<string, StoredDocument>>;

/** Whether a document is read whole, before the budget is applied. */
function readsWhole(doc: StoredDocument): boolean {
	return ALWAYS_WHOLE_SOURCE_TYPES.includes(doc.sourceType ?? "") || doc.text.length <= SHORT_DOCUMENT_CHARS;
}

/** The chunker packs paragraphs into chunks with no overlap (chunking.ts), so the chunks in
 *  chunk_index order are the document. */
const readFromStore: DocumentReader = async (ids) => {
	const rows = (await getDb().execute(sql`
		SELECT c.document_id, c.text, d.source_type
		FROM rag_chunks c
		JOIN rag_documents d ON d.id = c.document_id
		WHERE c.active = true
			AND c.embedding_model = ${embeddingModel()}
			AND c.document_id IN (${sql.join(
				ids.map((id) => sql`${id}`),
				sql`, `
			)})
		ORDER BY c.document_id, c.chunk_index
	`)) as unknown as Array<{ document_id: string; text: string; source_type: string | null }>;
	const parts = new Map<string, { texts: string[]; sourceType: string | null }>();
	for (const r of rows) {
		const doc = parts.get(r.document_id) ?? { texts: [], sourceType: r.source_type };
		doc.texts.push(r.text);
		parts.set(r.document_id, doc);
	}
	return new Map([...parts].map(([id, d]) => [id, { text: d.texts.join("\n\n"), sourceType: d.sourceType }]));
};

/** The admin-store document a hit was chunked from, or null for a catalog or federated hit. */
function documentIdOf(hit: Pick<Hit, "engine" | "documentId">): string | null {
	return hit.engine === "Potluck:Community" && hit.documentId ? hit.documentId : null;
}

export type WholeDocumentExpansion = {
	hits: Hit[];
	/** Index into `hits` → the whole document text to show the model in place of that hit's snippet. */
	bodies: Map<number, string>;
};

/**
 * Swap admin-store chunks for their whole document. Documents are taken in the rank order of their
 * best hit; an expanded document keeps its first hit (and so its citation slot) and drops its other
 * chunks. A long document that is not a policy ({@link readsWhole}), one that would take the turn past {@link WHOLE_DOCUMENT_BUDGET_CHARS}, or whose read
 * failed or timed out, keeps its chunks as they were. Text is never truncated: half a policy reads as
 * the whole of it.
 *
 * Only on a turn the cross-encoder verified. On the degrade path (reranker cold or down) the hits
 * cleared only the cosine floor, and a weak match on a 17k-character document would cost the prompt
 * 17k characters of text the gate never vouched for; those turns keep their chunks.
 */
export async function expandWholeDocuments(
	ranked: Hit[],
	relevanceVerified: boolean,
	read: DocumentReader = readFromStore,
	budget = WHOLE_DOCUMENT_BUDGET_CHARS,
	readMs = WHOLE_DOCUMENT_READ_MS
): Promise<WholeDocumentExpansion> {
	const ids = [...new Set(ranked.map(documentIdOf).filter((id): id is string => id !== null))];
	if (!relevanceVerified || ids.length === 0) return { hits: ranked, bodies: new Map() };

	const t0 = Date.now();
	const docs = await withTimeout(read(ids), readMs, new Map<string, StoredDocument>());
	const expanded = new Map<string, string>();
	const heldBack: { documentId: string; reason: "unread" | "long" | "budget"; chars?: number }[] = [];
	let left = budget;
	for (const id of ids) {
		const doc = docs.get(id);
		const text = doc?.text;
		if (!doc || !text?.trim()) heldBack.push({ documentId: id, reason: "unread" });
		else if (!readsWhole(doc)) heldBack.push({ documentId: id, reason: "long", chars: text.length });
		else if (text.length > left) heldBack.push({ documentId: id, reason: "budget", chars: text.length });
		else {
			expanded.set(id, text);
			left -= text.length;
		}
	}

	const hits: Hit[] = [];
	const bodies = new Map<number, string>();
	const placed = new Set<string>();
	for (const hit of ranked) {
		const id = documentIdOf(hit);
		const text = id ? expanded.get(id) : undefined;
		if (id && text !== undefined) {
			if (placed.has(id)) continue;
			placed.add(id);
			bodies.set(hits.length, text);
		}
		hits.push(hit);
	}
	logger.info(
		{ expanded: [...expanded.keys()], heldBack, chars: budget - left, ms: Date.now() - t0 },
		"[rag] documents read whole"
	);
	return { hits, bodies };
}
