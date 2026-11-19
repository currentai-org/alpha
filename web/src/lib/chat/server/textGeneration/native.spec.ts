import { describe, it, expect } from "vitest";
import { nativeLaneRewrites, nativeSystemPrompt } from "./native";
import { searchesBeforeRound1 } from "../search/nativeSearchGate";
import { UNSERVABLE_LIVE_CLAUSE } from "./persona";

const promptFor = (modelId: string) =>
	nativeSystemPrompt({
		modelId,
		fence: "msg-abc",
		today: "2026-10-05",
		web: true,
		account: { loginOffered: true, signedIn: false },
	});

describe("nativeLaneRewrites", () => {
	it("hands a backup lane serving another model the native prompt naming that model, not the one it replaced", () => {
		const model = { id: "mistral-large-2512", name: "mistral-large-2512", endpoints: [{}, { modelId: "mistral-medium-2604" }] };
		const system = promptFor(model.id);
		const rewrites = nativeLaneRewrites(model, system, promptFor);

		const [[from, to]] = rewrites["mistral-medium-2604"];
		expect(from).toBe(system);
		expect(system).toMatch(/^You are Mistral Large 3,/);
		expect(to).toMatch(/^You are Mistral Medium/);
		expect(to).not.toContain("Mistral Large 3");
	});

	it("leaves the primary lane and a same-model backup unrewritten", () => {
		const model = { id: "mistral-large-2512", name: "mistral-large-2512", endpoints: [{}, { modelId: "mistral-large-2512" }] };
		expect(nativeLaneRewrites(model, promptFor(model.id), promptFor)).toEqual({});
	});
});

describe("a live value no source here carries", () => {
	const base = { modelId: "mistral-large-2512", fence: "msg-abc", today: "2026-10-05", web: true, account: { loginOffered: true, signedIn: false } };
	it("tells the model it cannot look the value up, in place of the instruction to call web_search", () => {
		const p = nativeSystemPrompt({ ...base, unservableLive: true });
		expect(p).toContain(UNSERVABLE_LIVE_CLAUSE);
		expect(p).not.toContain("call web_search");
	});
	it("keeps the web_search instruction for an ordinary question", () => {
		const p = nativeSystemPrompt(base);
		expect(p).toContain("call web_search");
		expect(p).not.toContain(UNSERVABLE_LIVE_CLAUSE);
	});
});

describe("searchesBeforeRound1: on Auto the embedding gate's search verdict makes the server search before round 1", () => {
	const auto = { mode: "auto" as const, photoAttached: false, pastedUrl: false };
	it("searches first on Auto when the gate says search", () => {
		expect(searchesBeforeRound1({ ...auto, gateSaysSearch: true })).toBe(true);
	});
	it("leaves the choice with the model on Auto when the gate says no or gave no verdict", () => {
		expect(searchesBeforeRound1({ ...auto, gateSaysSearch: false })).toBe(false);
	});
	it("searches nothing first past a photo or a pasted link, which the turn reads first", () => {
		expect(searchesBeforeRound1({ ...auto, gateSaysSearch: true, photoAttached: true })).toBe(false);
		expect(searchesBeforeRound1({ ...auto, gateSaysSearch: true, pastedUrl: true })).toBe(false);
	});
	it("searches first on 'always' whatever the gate says, and never with search off", () => {
		expect(searchesBeforeRound1({ ...auto, mode: "always", gateSaysSearch: false })).toBe(true);
		expect(searchesBeforeRound1({ ...auto, mode: "off", gateSaysSearch: true })).toBe(false);
	});
});
