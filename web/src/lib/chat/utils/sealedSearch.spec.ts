import { afterEach, describe, expect, it, vi } from "vitest";
import { generateHistoryIdentity } from "$lib/chat/crypto/historyIdentity";
import { sealEnvelope } from "$lib/chat/crypto/sealedHistory";
import { loadSealedTitles, matchSealedTitles } from "./sealedSearch";

type SealedTitleRow = { id: string; sealedTitle: string; sealedTitleRev?: number; updatedAt: string; archived?: boolean; tags?: string[] };

/** The list route answering `rows`, then the dialog's load of it. */
function openSealedTitles(rows: SealedTitleRow[], identity: string, epoch: number, open?: Parameters<typeof loadSealedTitles>[3]) {
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ conversations: rows }), { status: 200 })));
	return loadSealedTitles("/chat/api/conversations/search/sealed", identity, epoch, open);
}

afterEach(() => vi.unstubAllGlobals());

// Search chats over sealed titles: real age blobs, opened with a real hybrid identity, so the
// slot binding runs as it does in the browser.

async function sealedRow(recipient: string, id: string, text: string, rev = 0, extra: Partial<SealedTitleRow> = {}) {
	return {
		id,
		sealedTitle: await sealEnvelope(recipient, { v: 1, kind: "title", conversationId: id, rev, text }),
		sealedTitleRev: rev,
		updatedAt: "2026-11-12T10:00:00Z",
		...extra,
	} satisfies SealedTitleRow;
}

describe("loadSealedTitles", () => {
	it("opens each sealed title with the history key, and a blob bound to another chat is left out", async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const heron = await sealedRow(recipient, "c1", "Heron migration notes", 2, { archived: true, tags: ["t1"] });
		const moved = { ...(await sealedRow(recipient, "c2", "Moved title")), id: "c3" };
		const rows = await openSealedTitles([heron, moved], identity, 1001);
		expect(rows).toEqual([
			{
				id: "c1",
				title: "Heron migration notes",
				updatedAt: new Date("2026-11-12T10:00:00Z"),
				archived: true,
				tags: ["t1"],
			},
		]);
	});

	it("opens a title once per keyring epoch, and again after the key changes", async () => {
		const open = vi.fn(async () => ({ text: "Cached title" }));
		const row: SealedTitleRow = { id: "c1", sealedTitle: "blob", sealedTitleRev: 0, updatedAt: "2026-11-12T10:00:00Z" };
		await openSealedTitles([row], "id", 2001, open);
		await openSealedTitles([row], "id", 2001, open);
		expect(open).toHaveBeenCalledTimes(1);
		await openSealedTitles([row], "id", 2002, open);
		expect(open).toHaveBeenCalledTimes(2);
		// A new revision of the same chat's title is a new blob, opened afresh.
		await openSealedTitles([{ ...row, sealedTitle: "blob2", sealedTitleRev: 1 }], "id", 2002, open);
		expect(open).toHaveBeenCalledTimes(3);
	});

	it("throws when the list cannot be fetched, so the dialog logs it rather than listing nothing silently", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
		await expect(loadSealedTitles("/x", "id", 4001)).rejects.toThrow(/answered 500/);
	});

	it("leaves out a title that throws while opening, rather than failing the whole list", async () => {
		const open = vi.fn(async (blob: string) => {
			if (blob === "bad") throw new Error("damaged");
			return { text: "Fine" };
		});
		const rows = await openSealedTitles(
			[
				{ id: "a", sealedTitle: "bad", updatedAt: "2026-11-12T10:00:00Z" },
				{ id: "b", sealedTitle: "good", updatedAt: "2026-11-12T10:00:00Z" },
			],
			"id",
			3001,
			open
		);
		expect(rows.map((r) => r.id)).toEqual(["b"]);
	});
});

describe("matchSealedTitles", () => {
	const rows = [
		{ id: "a", title: "Heron migration", updatedAt: new Date(0), tags: ["grant"] },
		{ id: "b", title: "Budget", updatedAt: new Date(0), tags: [] },
	];

	it("matches a lowercase substring of the opened title, and every tag", () => {
		expect(matchSealedTitles(rows, "heron", []).map((r) => r.id)).toEqual(["a"]);
		expect(matchSealedTitles(rows, "", ["grant"]).map((r) => r.id)).toEqual(["a"]);
		expect(matchSealedTitles(rows, "budget", ["grant"])).toEqual([]);
	});

	it("matches nothing for an empty query, so an idle dialog lists no sealed rows of its own", () => {
		expect(matchSealedTitles(rows, "", [])).toEqual([]);
	});
});
