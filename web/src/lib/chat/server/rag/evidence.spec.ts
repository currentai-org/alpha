import { describe, it, expect, vi } from "vitest";
import { mergeRagEvidence, withTimeout, withDeadline } from "./evidence";
import type { RagSource } from "$lib/chat/types/Rag";

const hit = (over: Partial<Omit<RagSource, "n">>): Omit<RagSource, "n"> => ({
	title: "T",
	snippet: "S",
	engine: "Potluck",
	...over,
});

describe("mergeRagEvidence — one global citation namespace", () => {
	it("numbers from 1 by default (no open-web sources this turn)", () => {
		const ctx = mergeRagEvidence("q", [hit({ title: "A" }), hit({ title: "B" })], undefined);
		expect(ctx.sources.map((s) => s.n)).toEqual([1, 2]);
		expect(ctx.evidence).toContain("[1] A (Potluck)");
		expect(ctx.evidence).toContain("[2] B (Potluck)");
	});

	it("offsets RAG citations past web sources so the combined sequence has no duplicate [n]", () => {
		// Upstream openSearch numbered 3 web sources [1..3]; RAG must continue at [4].
		const webNs = [1, 2, 3];
		const ctx = mergeRagEvidence(
			"q",
			[
				hit({ title: "Rag1", engine: "Potluck" }),
				hit({ title: "Rag2", engine: "Potluck:Community" }),
			],
			undefined,
			webNs.length
		);
		expect(ctx.sources.map((s) => s.n)).toEqual([4, 5]);
		expect(ctx.evidence).toContain("[4] Rag1 (Potluck)");
		expect(ctx.evidence).toContain("[5] Rag2 (Potluck:Community)");
		const all = [...webNs, ...ctx.sources.map((s) => s.n)];
		expect(new Set(all).size).toBe(all.length); // no collisions
		expect(all).toEqual([1, 2, 3, 4, 5]); // contiguous
	});

	it("offsets a mixed catalog+admin+EPFL set correctly after web", () => {
		const ctx = mergeRagEvidence(
			"q",
			[
				hit({ title: "Cat", engine: "Potluck" }),
				hit({ title: "Com", engine: "Potluck:Community" }),
				hit({ title: "Epfl", engine: "SyftHub:EPFL", url: "https://x" }),
			],
			undefined,
			2 // two web sources [1,2]
		);
		expect(ctx.sources.map((s) => s.n)).toEqual([3, 4, 5]);
		expect(ctx.evidence).toContain("[5] Epfl (SyftHub:EPFL)");
		expect(ctx.evidence).toContain("https://x");
	});

	it("keeps vault synthesis separate from numbered sources even with an offset", () => {
		const ctx = mergeRagEvidence("q", [], "Charlie Chaplin lived in Vevey.", 4);
		expect(ctx.sources).toHaveLength(0);
		expect(ctx.evidence).toBe("");
		expect(ctx.vaultSynthesis).toBe("Charlie Chaplin lived in Vevey.");
	});

	it("carries relevanceVerified (default false; true when the cross-encoder vetted the hits)", () => {
		// Default: no cross-encoder verification claimed (the degrade / disabled / vault paths).
		expect(mergeRagEvidence("q", [hit({ title: "A" })], undefined).relevanceVerified).toBe(false);
		// Explicit true: rerankRagHits verified this turn's hits.
		expect(mergeRagEvidence("q", [hit({ title: "A" })], undefined, 0, true).relevanceVerified).toBe(
			true
		);
	});
});

describe("withTimeout — reject-safe fail-open", () => {
	it("resolves the underlying value when it settles in time", async () => {
		await expect(withTimeout(Promise.resolve("ok"), 1000, "fb")).resolves.toBe("ok");
	});

	it("a REJECTING promise resolves to the fallback (never propagates)", async () => {
		await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "fb")).resolves.toBe("fb");
	});

	it("a slow promise resolves to the fallback at the timeout", async () => {
		const slow = new Promise<string>((r) => setTimeout(() => r("late"), 80));
		await expect(withTimeout(slow, 5, "fb")).resolves.toBe("fb");
	});

	it("a rejecting store can't error a Promise.all of stores — committed hits stay intact", async () => {
		// The orchestrator invariant: queryLocalStore succeeds while a sibling store throws.
		const [catalog, admin] = await Promise.all([
			withTimeout(Promise.resolve(["catalog-hit"]), 1000, [] as string[]),
			withTimeout(Promise.reject(new Error("db down")), 1000, [] as string[]),
		]);
		expect(catalog).toEqual(["catalog-hit"]);
		expect(admin).toEqual([]);
	});
});

describe("withDeadline — single deadline that aborts the metered call", () => {
	const never = new Promise<string>(() => {}); // never settles

	it("runs onTimeout once and resolves the fallback when the timer wins", async () => {
		const onTimeout = vi.fn();
		await expect(withDeadline(never, 5, onTimeout, "fb")).resolves.toBe("fb");
		expect(onTimeout).toHaveBeenCalledTimes(1);
	});

	it("does NOT run onTimeout when the promise wins (pending timer cleared)", async () => {
		const onTimeout = vi.fn();
		await expect(withDeadline(Promise.resolve("ok"), 1000, onTimeout, "fb")).resolves.toBe("ok");
		await new Promise((r) => setTimeout(r, 20)); // give any stray timer a chance to (not) fire
		expect(onTimeout).not.toHaveBeenCalled();
	});

	it("is reject-safe and does not abort on a normal rejection", async () => {
		const onTimeout = vi.fn();
		await expect(
			withDeadline(Promise.reject(new Error("boom")), 1000, onTimeout, "fb")
		).resolves.toBe("fb");
		expect(onTimeout).not.toHaveBeenCalled();
	});
});

describe("mergeRagEvidence — generic SyftHub label", () => {
	it("renders SyftHub:<sourceName> for the generic federated engine", () => {
		const ctx = mergeRagEvidence(
			"q",
			[hit({ title: "Doc", engine: "SyftHub", sourceName: "acme/news" })],
			undefined
		);
		expect(ctx.evidence).toContain("[1] Doc (SyftHub:acme/news)");
	});
});

const CATALOG_ENTRY_NOTE =
	"(Catalog entry about another project listed in the AI Potluck catalog. It describes that project, never this app or its own tools.)";

describe("mergeRagEvidence — catalog entries are framed as other projects (CUR-3304)", () => {
	it("marks a catalog product or org page as describing another project, never this app", () => {
		const ctx = mergeRagEvidence(
			"can you search the web?",
			[
				hit({ title: "OpenAI Web Search", snippet: "Searches the web.", url: "/product/openai-web-search" }),
				hit({ title: "Mozilla", url: "https://www.aipotluck.org/org/mozilla" }),
			],
			undefined
		);
		const [product, org] = ctx.evidence.split("\n\n");
		expect(product).toBe(
			`[1] OpenAI Web Search (Potluck)\n${CATALOG_ENTRY_NOTE}\nSearches the web.\n/product/openai-web-search`
		);
		expect(org).toContain(CATALOG_ENTRY_NOTE);
	});

	it("leaves authored corpus pages and web sources unmarked, since those may describe Alpha itself", () => {
		const ctx = mergeRagEvidence(
			"q",
			[
				hit({ title: "Privacy", url: "/privacy" }),
				hit({ title: "Web", engine: "SyftHub:EPFL", url: "https://example.org/product/x" }),
				hit({ title: "No url" }),
			],
			undefined
		);
		expect(ctx.evidence).not.toContain(CATALOG_ENTRY_NOTE);
	});
});
