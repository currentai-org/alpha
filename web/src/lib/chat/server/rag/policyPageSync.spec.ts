import { describe, expect, it, vi } from "vitest";
import type { LexicalNode } from "$lib/lexical/types";
import { RagConflictError, type RagDocumentListItem } from "./adminWrites";
import {
	isPolicyPagePath,
	lexicalToParagraphs,
	sourceFor,
	syncPolicyPage,
	type PolicySyncDeps,
} from "./policyPageSync";

const t = (text: string): LexicalNode => ({ type: "text", version: 1, text });
const block = (type: string, children: LexicalNode[], extra: Record<string, unknown> = {}): LexicalNode => ({
	type,
	version: 1,
	children,
	...extra,
});
const doc = (...children: LexicalNode[]) => ({ root: { children } });

describe("lexicalToParagraphs", () => {
	it("keeps each block on its own paragraph so the chunker can split between them", () => {
		const text = lexicalToParagraphs(
			doc(
				block("heading", [t("Who we are")], { tag: "h2" }),
				block("paragraph", [t("Last updated:"), t(" 22 Aug 2026")]),
				block("paragraph", [block("link", [t("Contact us")]), t(" any time.")])
			)
		);
		expect(text).toBe("Who we are\n\nLast updated: 22 Aug 2026\n\nContact us any time.");
	});

	it("renders list items as dash lines, nested lists included", () => {
		const text = lexicalToParagraphs(
			doc(
				block("list", [
					block("listitem", [t("Chats")]),
					block("listitem", [t("Uploads"), block("list", [block("listitem", [t("Images")])])]),
				])
			)
		);
		expect(text).toBe("- Chats\n\n- Uploads\n\n- Images");
	});

	it("renders a table row as its cells joined with a bar", () => {
		const cell = (s: string) => block("tablecell", [block("paragraph", [t(s)])]);
		const text = lexicalToParagraphs(
			doc(block("table", [block("tablerow", [cell("Partner"), cell("Role")]), block("tablerow", [cell("Neon"), cell("Database")])]))
		);
		expect(text).toBe("Partner | Role\n\nNeon | Database");
	});

	it("returns empty for a page with no body, so the sync skips instead of uploading nothing", () => {
		expect(lexicalToParagraphs(null)).toBe("");
		expect(lexicalToParagraphs(doc(block("paragraph", [t("   ")])))).toBe("");
	});
});

describe("isPolicyPagePath", () => {
	it("accepts only the three policy pages", () => {
		expect(isPolicyPagePath("/privacy-notice")).toBe(true);
		expect(isPolicyPagePath("/privacy")).toBe(false);
		expect(isPolicyPagePath(undefined)).toBe(false);
	});
});

const PAGE_TEXT = "Trust & Safety\n\nWe screen every message.";

function listItem(over: Partial<RagDocumentListItem>): RagDocumentListItem {
	return {
		id: "x",
		title: "Trust & Safety",
		url: null,
		source: "",
		sourceType: null,
		sourceDate: null,
		status: "active",
		createdBy: null,
		approvedBy: null,
		approvedAt: null,
		createdAt: new Date("2026-07-01T00:00:00Z"),
		updatedAt: null,
		editedAt: null,
		version: 1,
		chunkCount: 1,
		activeChunkCount: 1,
		...over,
	};
}

function fakeDeps(initial: RagDocumentListItem[], page: { title: string; text: string } | null = { title: "Trust & Safety", text: PAGE_TEXT }) {
	const rows = [...initial];
	const deps: PolicySyncDeps = {
		fetchPage: vi.fn(async () => page),
		list: vi.fn(async () => rows.map((r) => ({ ...r }))),
		create: vi.fn(async (input) => {
			const row = listItem({ id: "new", title: input.title, url: input.url ?? null, source: input.source, status: "draft", createdAt: new Date("2026-10-07T00:00:00Z") });
			rows.push(row);
			return { doc: row as never, duplicateChunkCount: 0 };
		}),
		activate: vi.fn(async (id) => {
			const row = rows.find((r) => r.id === id)!;
			row.status = "active";
			row.version += 1;
			return row as never;
		}),
		retire: vi.fn(async (id, version) => {
			const row = rows.find((r) => r.id === id)!;
			if (row.version !== version) throw new RagConflictError(null, null);
			row.status = "retired";
			row.version += 1;
			return row as never;
		}),
		update: vi.fn(async (id, patch) => {
			const row = rows.find((r) => r.id === id)!;
			Object.assign(row, patch);
			row.version += 1;
			return row as never;
		}),
		origin: () => "https://develop.aipotluck.org",
	};
	return { deps, rows };
}

describe("syncPolicyPage", () => {
	it("writes with a null actor, since created_by and approved_by must name a real user", async () => {
		const { deps } = fakeDeps([listItem({ id: "legacy", source: "trust-and-safety.md.txt" })]);
		await syncPolicyPage("/trust-and-safety", deps);
		for (const fn of [deps.create, deps.activate, deps.retire, deps.update]) {
			const calls = (fn as ReturnType<typeof vi.fn>).mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			for (const call of calls) expect(call.at(-1)).toBeNull();
		}
	});

	it("replaces the July text upload with the published page, retired and renamed OLD-", async () => {
		const { deps, rows } = fakeDeps([listItem({ id: "legacy", source: "trust-and-safety.md.txt" })]);
		const result = await syncPolicyPage("/trust-and-safety", deps);
		expect(result).toMatchObject({ outcome: "replaced", documentId: "new", retired: ["legacy"] });
		expect(rows.find((r) => r.id === "new")).toMatchObject({
			status: "active",
			url: "https://develop.aipotluck.org/trust-and-safety",
			source: sourceFor("/trust-and-safety", PAGE_TEXT),
		});
		expect(rows.find((r) => r.id === "legacy")).toMatchObject({ status: "retired", title: "OLD-Trust & Safety" });
	});

	it("leaves the corpus alone when a republish did not change the page text", async () => {
		const { deps } = fakeDeps([
			listItem({ id: "synced", url: "https://develop.aipotluck.org/trust-and-safety", source: sourceFor("/trust-and-safety", PAGE_TEXT) }),
		]);
		expect(await syncPolicyPage("/trust-and-safety", deps)).toEqual({ outcome: "unchanged", documentId: "synced" });
		expect(deps.create).not.toHaveBeenCalled();
	});

	it("never retires an active copy newer than its own, so racing publishes settle on the newest", async () => {
		const newer = listItem({ id: "newer", url: "https://develop.aipotluck.org/trust-and-safety", source: "cms:/trust-and-safety#other", createdAt: new Date("2026-10-08T00:00:00Z") });
		const { deps, rows } = fakeDeps([newer]);
		await syncPolicyPage("/trust-and-safety", deps);
		expect(rows.find((r) => r.id === "newer")?.status).toBe("active");
	});

	it("treats a retire that another run already made as done, not as a failure", async () => {
		const { deps } = fakeDeps([listItem({ id: "legacy", source: "trust-and-safety.md.txt" })]);
		deps.retire = vi.fn(async () => {
			throw new RagConflictError(null, null);
		});
		await expect(syncPolicyPage("/trust-and-safety", deps)).resolves.toMatchObject({ outcome: "replaced", retired: [] });
	});

	it("does not touch another page's documents or an unrelated upload", async () => {
		const { deps, rows } = fakeDeps([
			listItem({ id: "terms", url: "https://develop.aipotluck.org/terms-of-use", source: "cms:/terms-of-use#a" }),
			listItem({ id: "faq", source: "faq.md" }),
		]);
		await syncPolicyPage("/trust-and-safety", deps);
		expect(rows.filter((r) => r.status === "active").map((r) => r.id).sort()).toEqual(["faq", "new", "terms"]);
	});

	it("skips, writing nothing, when the page is not published", async () => {
		const { deps } = fakeDeps([listItem({ id: "legacy", source: "trust-and-safety.md.txt" })], null);
		expect(await syncPolicyPage("/trust-and-safety", deps)).toMatchObject({ outcome: "skipped" });
		expect(deps.retire).not.toHaveBeenCalled();
	});
});
