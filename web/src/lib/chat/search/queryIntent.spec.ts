import { describe, it, expect } from "vitest";
import { classifyQueryIntent, unionSignals, type SearchIntent } from "./queryIntent";

// Strict unique-argmax precedence: `confident` iff exactly one intent holds the (≥1) max keyword-group
// count; any tie → general (the uniform engine net, so nothing is dropped). `signals` is the full set of
// present intents, used by engineBudgets to rescue a specialized engine for a present secondary intent.
describe("classifyQueryIntent", () => {
	it("confident news for a current-events/policy query", () => {
		const r = classifyQueryIntent("latest news on the EU AI regulation");
		expect(r.intent).toBe("news");
		expect(r.confident).toBe(true);
		expect(r.signals.has("news")).toBe(true);
	});

	it("confident models for an open-weights release query (HF's turf)", () => {
		const r = classifyQueryIntent("open weights llm released on hugging face");
		expect(r.intent).toBe("models");
		expect(r.confident).toBe(true);
		expect(r.signals.has("models")).toBe(true);
	});

	it("confident research for a paper/benchmark query", () => {
		const r = classifyQueryIntent("benchmark results in a recent research paper");
		expect(r.intent).toBe("research");
		expect(r.confident).toBe(true);
		// 'recent' also lights the news signal — recorded for rescue, but research is the unique argmax.
		expect(r.signals.has("news")).toBe(true);
	});

	it("confident reference for a definitional query", () => {
		const r = classifyQueryIntent("what is a transformer");
		expect(r.intent).toBe("reference");
		expect(r.confident).toBe(true);
	});

	it("TIE → general (not confident), but both signals recorded for rescue", () => {
		// 'latest' (news) + 'model' (models) each score 1 → tie → general (uniform net, HF still launches).
		const r = classifyQueryIntent("latest model");
		expect(r.intent).toBe("general");
		expect(r.confident).toBe(false);
		expect(r.signals.has("news")).toBe(true);
		expect(r.signals.has("models")).toBe(true);
	});

	it("no specialized signal → general, empty signals", () => {
		const r = classifyQueryIntent("how do I sort a list in python");
		expect(r.intent).toBe("general");
		expect(r.confident).toBe(false);
		expect(r.signals.size).toBe(0);
	});

	it("too-short / empty → general, not confident", () => {
		expect(classifyQueryIntent("").confident).toBe(false);
		expect(classifyQueryIntent("hi").intent).toBe("general");
	});
});

describe("unionSignals — recall-safe union (only adds rescues)", () => {
	it("undefined/empty raw → the finalized set unchanged", () => {
		const fin = new Set<SearchIntent>(["research"]);
		expect(unionSignals(undefined, fin)).toBe(fin);
		expect([...unionSignals(new Set(), fin)]).toEqual(["research"]);
	});

	it("adds a raw signal absent from the finalized set (the follow-up rescue case)", () => {
		// finalized query classified as news; raw text carried a models signal → union keeps both so HF is
		// rescued even though the finalized query alone wouldn't have.
		const out = unionSignals(new Set<SearchIntent>(["models"]), new Set<SearchIntent>(["news"]));
		expect(out.has("news")).toBe(true);
		expect(out.has("models")).toBe(true);
	});
});
