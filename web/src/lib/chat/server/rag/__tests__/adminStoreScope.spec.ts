/**
 * The admin-authored corpus is one table, and `rag_documents.organization_id` marks a
 * workspace's own document. Retrieval has to read that mark, or the first workspace document would be
 * cited to every visitor as shared Potluck evidence. These tests seed real documents and chunks and run
 * the real query; only the query embedding and the RAG_ADMIN_ENABLED gate are stubbed. (CUR-4152)
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { organization, ragChunks, ragDocuments } from "$lib/chat/server/db/schema";
import { embeddingModel } from "$lib/chat/server/rag/env";

// Every seeded chunk and the query share one vector, so each scores 1 and the scope is the only
// thing deciding what comes back.
const VECTOR = [1, 0, 0];
vi.mock("$lib/chat/server/rag/embed", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/rag/embed")>()),
	embedText: async () => VECTOR,
}));
vi.mock("$lib/chat/server/rag/env", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/rag/env")>()),
	ragAdminEnabled: () => true,
}));

const { queryAdminStore, previewAdminQuery } = await import("$lib/chat/server/rag/adminStore");

const run = crypto.randomUUID();
const orgA = `rag-scope-a-${run}`;
const orgB = `rag-scope-b-${run}`;
const docs = { siteWide: `rag-scope-site-${run}`, inA: `rag-scope-in-a-${run}`, inB: `rag-scope-in-b-${run}` };
const seeded = Object.values(docs);

async function retrievedFor(workspaceId: string | null): Promise<string[]> {
	const sources = await queryAdminStore("what does the team handbook say", workspaceId);
	return sources.map((s) => s.documentId!).filter((id) => seeded.includes(id)).sort();
}

describe.sequential("admin RAG retrieval is scoped to the asker's workspace (CUR-4152)", () => {
	beforeEach(async () => {
		const db = getDb();
		const now = new Date();
		await db.insert(organization).values([
			{ id: orgA, name: "Field team", slug: orgA, createdAt: now },
			{ id: orgB, name: "Another team", slug: orgB, createdAt: now },
		]);
		await db.insert(ragDocuments).values([
			{ id: docs.siteWide, title: "Site-wide note", source: "test", status: "active" },
			{ id: docs.inA, title: "Field team handbook", source: "test", status: "active", organizationId: orgA },
			{ id: docs.inB, title: "Another team handbook", source: "test", status: "active", organizationId: orgB },
		]);
		await db.insert(ragChunks).values(
			seeded.map((documentId) => ({
				id: `${documentId}-c0`,
				documentId,
				chunkIndex: 0,
				text: `The handbook text of ${documentId}.`,
				vector: VECTOR,
				embeddingModel: embeddingModel(),
				dim: VECTOR.length,
				contentHash: `${documentId}-hash`,
				active: true,
			}))
		);
	});

	afterEach(async () => {
		const db = getDb();
		await db.delete(ragDocuments).where(inArray(ragDocuments.id, seeded));
		await db.delete(organization).where(inArray(organization.id, [orgA, orgB]));
	});

	it("a document in workspace A is never retrieved for a member of workspace B or a visitor with no workspace", async () => {
		expect(await retrievedFor(orgB)).not.toContain(docs.inA);
		expect(await retrievedFor(null)).not.toContain(docs.inA);
		expect(await retrievedFor(null)).not.toContain(docs.inB);
	});

	it("a member of workspace A gets workspace A's documents and the site-wide ones, nothing from B", async () => {
		expect(await retrievedFor(orgA)).toEqual([docs.inA, docs.siteWide].sort());
	});

	it("site-wide documents come back for every asker, with or without a workspace", async () => {
		for (const workspaceId of [null, orgA, orgB]) {
			expect(await retrievedFor(workspaceId)).toContain(docs.siteWide);
		}
	});

	it("one workspace's cached chunks never answer another's turn", async () => {
		// Warm the cache for A, then ask as B and as a visitor with nothing changed in between.
		expect(await retrievedFor(orgA)).toContain(docs.inA);
		expect(await retrievedFor(orgB)).not.toContain(docs.inA);
		expect(await retrievedFor(null)).not.toContain(docs.inA);
	});

	it("the admin preview shows the site-wide corpus unless it names a workspace", async () => {
		const shown = async (workspaceId?: string | null) =>
			(await previewAdminQuery("handbook", workspaceId)).hits.map((h) => h.documentId!).filter((id) => seeded.includes(id));
		expect(await shown()).toEqual([docs.siteWide]);
		expect((await shown(orgB)).sort()).toEqual([docs.inB, docs.siteWide].sort());
	});
});
