import { describe, it, expect, vi, beforeEach } from "vitest";

const decide = vi.fn();
// An Error return stands for a rejection, made here rather than inside vi.fn, whose result tracking
// leaves its own copy of a rejected promise unhandled.
vi.mock("./searchIntent", () => ({
	decideSearchViaIntent: (...a: unknown[]) => {
		const r = decide(...a);
		return r instanceof Error ? Promise.reject(r) : r;
	},
}));

import { nativeGateSaysSearch } from "./nativeSearchGate";

const searchYes = { shouldSearch: true, ok: true, margin: 0.05 };
const notSelf = async () => ({ isSelf: false, ok: true, margin: -0.2 });

beforeEach(() => decide.mockReset());

describe("nativeGateSaysSearch forces a search only on a gate verdict of search (CUR-4083)", () => {
	it("says search when the gate says search and the question is not about Alpha", async () => {
		decide.mockResolvedValue(searchYes);
		expect(await nativeGateSaysSearch("I'm a tenant in England, what are my rights?", notSelf)).toBe(true);
	});

	it("says no when the gate says no", async () => {
		decide.mockResolvedValue({ shouldSearch: false, ok: true, margin: -0.1 });
		expect(await nativeGateSaysSearch("Write a thank-you letter to my neighbour", notSelf)).toBe(false);
	});

	it("says no when the gate has no opinion, so a degraded embedder never forces searches", async () => {
		decide.mockResolvedValue({ shouldSearch: true, ok: false, margin: 0, reason: "no-vector" });
		expect(await nativeGateSaysSearch("anything", notSelf)).toBe(false);
	});

	it("says no for a question about Alpha itself, even when the gate says search (CUR-2135)", async () => {
		decide.mockResolvedValue(searchYes);
		const self = async () => ({ isSelf: true, ok: true, margin: 0.3 });
		expect(await nativeGateSaysSearch("Quel modèle es-tu, et qui le fait tourner ?", self)).toBe(false);
	});

	it("says no when the gate itself rejects, so an embedder error never fails the turn", async () => {
		decide.mockReturnValue(new Error("embedder down"));
		expect(await nativeGateSaysSearch("anything", notSelf)).toBe(false);
	});

	it("says no when the gate is slower than the budget, leaving the choice with the model", async () => {
		decide.mockReturnValue(new Promise((r) => setTimeout(() => r(searchYes), 200)));
		expect(await nativeGateSaysSearch("anything", notSelf, 20)).toBe(false);
	});

	it("says no when our catalog has the question, so a catalog product is read through search_catalog, not the web", async () => {
		decide.mockResolvedValue(searchYes);
		expect(await nativeGateSaysSearch("What is OpenGuardrails?", notSelf, undefined, async () => 3)).toBe(false);
	});

	it("still forces a search past a catalog hit when the message wants something recent, or the catalog has nothing", async () => {
		decide.mockResolvedValue(searchYes);
		const hits = vi.fn(async () => 3);
		expect(await nativeGateSaysSearch("OpenGuardrails news this week", notSelf, undefined, hits, true)).toBe(true);
		expect(hits).not.toHaveBeenCalled();
		expect(await nativeGateSaysSearch("tenant rights in England", notSelf, undefined, async () => 0)).toBe(true);
		expect(
			await nativeGateSaysSearch("tenant rights in England", notSelf, undefined, () => Promise.reject(new Error("db down")))
		).toBe(true);
	});

	it("still decides when the identity verdict throws or there is none", async () => {
		decide.mockResolvedValue(searchYes);
		expect(await nativeGateSaysSearch("anything", () => Promise.reject(new Error("embed down")))).toBe(true);
		expect(await nativeGateSaysSearch("anything")).toBe(true);
	});
});

describe("nativeGateSaysSearch names the identity reading on a forced search (CUR-2135)", () => {
	it("logs not-self with its margin, and missed-budget for a verdict slower than the budget", async () => {
		const { logger } = await import("$lib/chat/server/logger");
		const info = vi.spyOn(logger, "info");
		decide.mockResolvedValue(searchYes);
		await nativeGateSaysSearch("tenant rights in England", notSelf);
		expect(info).toHaveBeenLastCalledWith(
			expect.objectContaining({ identity: "not-self", identityMargin: -0.2 }),
			"[search] gate said search; forcing web_search"
		);
		const slow = () => new Promise<never>(() => {});
		expect(await nativeGateSaysSearch("Quel modèle es-tu ?", slow, 20)).toBe(true);
		expect(info).toHaveBeenLastCalledWith(
			expect.objectContaining({ identity: "missed-budget", identityBudgetMs: 20 }),
			"[search] gate said search; forcing web_search"
		);
		info.mockRestore();
	});
});
