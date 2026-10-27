import { describe, it, expect } from "vitest";
import { gapForPrompt, normalizeStarter, webSearchGapFor } from "./starterGaps";

const ELECTRIC_CARS =
	"Fact-check this: electric cars are worse for the climate than petrol cars once you count the battery.";
const BUILDER =
	"I'm building a chatbot on open components. What open-source options exist for the model, vector store, and moderation layer — and where is the open stack still thin?";

describe("starterGaps", () => {
	it("maps the electric-cars fact-check to the websearch gap (node meaning matches the ask)", () => {
		expect(gapForPrompt(ELECTRIC_CARS)).toEqual({
			node: "websearch",
			ask: "a Google-scale open web search index",
		});
	});

	it("matches despite whitespace / case differences (chip vs paste)", () => {
		expect(gapForPrompt(`  ${ELECTRIC_CARS.toUpperCase()}  `)?.node).toBe("websearch");
	});

	it("surfaces NO gap for the builder prompt — it spans layers with no single matching node", () => {
		expect(gapForPrompt(BUILDER)).toBeUndefined();
	});

	it("returns undefined for uncurated / empty / nullish input (never infers a gap)", () => {
		expect(gapForPrompt("What model are you running on right now?")).toBeUndefined();
		expect(gapForPrompt("")).toBeUndefined();
		expect(gapForPrompt(undefined)).toBeUndefined();
		expect(gapForPrompt(null)).toBeUndefined();
	});

	it("normalizeStarter collapses whitespace and lowercases", () => {
		expect(normalizeStarter("  Foo   Bar\n")).toBe("foo bar");
	});
});

// Answer texts shaped like real web-grounded answers: markdown, a citation marker, a figure.
const EN_ANSWER =
	"The capital of Japan is **Tokyo**, which has been the seat of government since 1868 [1]. It is also the country's largest city.";
const FR_ANSWER =
	"La capitale du Japon est **Tokyo**, qui est le siège du gouvernement depuis 1868 [1]. C'est aussi la plus grande ville du pays.";
const ES_ANSWER =
	"La capital de Japón es **Tokio**, que es la sede del gobierno desde 1868 [1]. También es la ciudad más grande del país.";

const WEB_SEARCH_GAP = { node: "websearch", ask: "a Google-scale open web search index" };

describe("webSearchGapFor: the card shows only under an answer in the card's own language (CUR-2377)", () => {
	it("an English browser gets the card under an English answer", () => {
		expect(webSearchGapFor(EN_ANSWER, "en")).toEqual(WEB_SEARCH_GAP);
	});

	it("an English browser gets no card under a French or Spanish answer", () => {
		expect(webSearchGapFor(FR_ANSWER, "en")).toBeUndefined();
		expect(webSearchGapFor(ES_ANSWER, "en")).toBeUndefined();
	});

	it("a French browser gets its French card under a French answer, and none under an English one", () => {
		expect(webSearchGapFor(FR_ANSWER, "fr")).toEqual(WEB_SEARCH_GAP);
		expect(webSearchGapFor(EN_ANSWER, "fr")).toBeUndefined();
	});

	it("a French browser keeps its card under short French answers the heuristic ranks Spanish first (CUR-2394)", () => {
		for (const answer of [
			"La capitale du Japon est Tokyo.",
			"La capitale du Japon est Tokyo, qui est aussi la plus grande ville du pays [1].",
			"Selon les sources récentes, la population de Paris est d'environ 2,1 millions d'habitants.",
		]) {
			expect(webSearchGapFor(answer, "fr"), answer).toEqual(WEB_SEARCH_GAP);
			expect(webSearchGapFor(answer, "en"), answer).toBeUndefined();
		}
	});

	it("a browser language with no translation reads the English card, so it follows the English rule", () => {
		expect(webSearchGapFor(EN_ANSWER, "ja")).toEqual(WEB_SEARCH_GAP);
		expect(webSearchGapFor(FR_ANSWER, undefined)).toBeUndefined();
	});

	it("shows no card for an empty answer or one whose language is undecided", () => {
		expect(webSearchGapFor("", "en")).toBeUndefined();
		expect(webSearchGapFor(undefined, "en")).toBeUndefined();
		expect(webSearchGapFor("1868 [1]", "en")).toBeUndefined();
	});
});
