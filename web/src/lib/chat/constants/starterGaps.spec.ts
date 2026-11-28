import { describe, it, expect } from "vitest";
import { gapForAnswer, normalizeStarter } from "./starterGaps";

const ELECTRIC_CARS =
	"Fact-check this: electric cars are worse for the climate than petrol cars once you count the battery.";
const BUILDER =
	"I'm building a chatbot on open components. What open-source options exist for the model, vector store, and moderation layer — and where is the open stack still thin?";

describe("starterGaps", () => {
	it("maps the electric-cars fact-check to the websearch gap (node meaning matches the ask)", () => {
		expect(gapForAnswer(ELECTRIC_CARS, false)).toEqual({
			node: "websearch",
			ask: "a Google-scale open web search index",
		});
	});

	it("matches despite whitespace / case differences (chip vs paste)", () => {
		expect(gapForAnswer(`  ${ELECTRIC_CARS.toUpperCase()}  `, false)?.node).toBe("websearch");
	});

	it("surfaces NO gap for the builder prompt — it spans layers with no single matching node", () => {
		expect(gapForAnswer(BUILDER, false)).toBeUndefined();
	});

	it("returns undefined for uncurated / empty / nullish input (never infers a gap)", () => {
		expect(gapForAnswer("What model are you running on right now?", false)).toBeUndefined();
		expect(gapForAnswer("", false)).toBeUndefined();
		expect(gapForAnswer(undefined, false)).toBeUndefined();
		expect(gapForAnswer(null, false)).toBeUndefined();
	});

	it("normalizeStarter collapses whitespace and lowercases", () => {
		expect(normalizeStarter("  Foo   Bar\n")).toBe("foo bar");
	});
});

const WEB_SEARCH_GAP = { node: "websearch", ask: "a Google-scale open web search index" };

describe("gapForAnswer: the gap X-ray's This answer tab offers", () => {
	it("offers the web-search gap for an answer that searched the web, whatever it asked", () => {
		expect(gapForAnswer("Quelle est la capitale du Japon ?", true)).toEqual(WEB_SEARCH_GAP);
		expect(gapForAnswer(undefined, true)).toEqual(WEB_SEARCH_GAP);
	});

	it("offers no gap for an answer that did not search the web and asked no curated prompt", () => {
		expect(gapForAnswer("What is the capital of Japan?", false)).toBeUndefined();
		expect(gapForAnswer(undefined, false)).toBeUndefined();
	});

	it("offers a curated prompt's gap even when that turn found no web sources", () => {
		expect(gapForAnswer(ELECTRIC_CARS, false)).toEqual(WEB_SEARCH_GAP);
	});
});
