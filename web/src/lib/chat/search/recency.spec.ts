import { describe, it, expect } from "vitest";
import {
	asksForTheLatest,
	isRecencyQuery,
	isRecencyQueryDenoised,
	isTechnicalContext,
	isUnservableLiveQuery,
	isExplicitLookupRequest,
} from "./recency";

// This heuristic is load-bearing: it is the "layer" that DECIDES
// whether a turn runs an open-web search (there is no manual toggle — see
// ChatWindow.handleSubmit). A false positive costs latency + injects sources; a
// false negative silently answers stale from training. These tests pin the
// trigger boundary so a regex tweak can't quietly change what auto-searches.
describe("isRecencyQuery — the auto-search trigger", () => {
	it("fires on explicit recency words", () => {
		expect(isRecencyQuery("what is the latest news on the EU AI Act?")).toBe(true);
		expect(isRecencyQuery("who is the current president of Switzerland")).toBe(true);
		expect(isRecencyQuery("what happened this week in open AI")).toBe(true);
		expect(isRecencyQuery("status of the next Apertus release")).toBe(true);
	});

	it("fires on explicit years (2024+)", () => {
		expect(isRecencyQuery("biggest open models of 2025")).toBe(true);
		expect(isRecencyQuery("what shipped in 2030")).toBe(true);
	});

	it("fires on the documented look-it-up scenario", () => {
		expect(isRecencyQuery("can you look that up for me")).toBe(true);
		expect(isRecencyQuery("how do you find out which model is newest")).toBe(true);
		expect(isRecencyQuery("please fact-check this claim")).toBe(true);
	});

	it("does NOT fire on timeless / training-answerable questions", () => {
		expect(isRecencyQuery("explain how a transformer attention head works")).toBe(false);
		expect(isRecencyQuery("write a haiku about the ocean")).toBe(false);
		expect(isRecencyQuery("what is the capital of France")).toBe(false);
		expect(isRecencyQuery("refactor this function to be pure")).toBe(false);
	});

	it("does NOT fire on trivially short or empty drafts", () => {
		expect(isRecencyQuery("")).toBe(false);
		expect(isRecencyQuery("hi")).toBe(false);
		expect(isRecencyQuery("   ")).toBe(false);
	});

	it("does not match years before 2024 (no over-firing on historical dates)", () => {
		expect(isRecencyQuery("what happened in 2010")).toBe(false);
		expect(isRecencyQuery("summarize the 1999 dot-com boom")).toBe(false);
	});
});

describe("isRecencyQueryDenoised (de-noised search fast-path)", () => {
	it("suppresses the recency signal on obvious coding/technical how-tos", () => {
		// raw heuristic fires (trap words), de-noise correctly suppresses
		for (const q of [
			"how do I get the current date in Python?",
			"how do I check the status of a systemd service?",
			"what does the latest tag mean in a Docker image?",
			"how do I print the current working directory in bash?",
			"what's the current flowing through a 10-ohm resistor?",
		]) {
			expect(isRecencyQuery(q)).toBe(true);
			expect(isTechnicalContext(q)).toBe(true);
			expect(isRecencyQueryDenoised(q)).toBe(false);
		}
	});

	it("still fires on genuine current-events recency (non-technical)", () => {
		for (const q of [
			"what is the latest news on the EU AI Act?",
			"what is the current price of Bitcoin?",
			"who won the most recent F1 race?",
			"what are today's headlines?",
		]) {
			expect(isRecencyQueryDenoised(q)).toBe(true);
		}
	});

	it("leaves timeless coding questions non-firing either way (no trap word)", () => {
		expect(isRecencyQuery("write a python function to reverse a list")).toBe(false);
		expect(isRecencyQueryDenoised("write a python function to reverse a list")).toBe(false);
	});

	it("over-suppresses genuinely-current technical queries (documented; model backstops)", () => {
		// "latest Node.js release" IS current info, but the technical filter suppresses it.
		// Acceptable: in the model/tool strategy the classifier still catches it.
		expect(isRecencyQuery("what is the latest stable Node.js release?")).toBe(true);
		expect(isRecencyQueryDenoised("what is the latest stable Node.js release?")).toBe(false);
	});
});

// The L2 serveability gate: queries for structurally-LIVE data the open engines can't serve. Firing here forces skip-grounding (even under manual "always") + an honest persona note.
// Precision-leaning: a false positive only costs an honest ungrounded answer; L3 backstops a false negative.
describe("isUnservableLiveQuery — the serveability gate", () => {
	it("fires on live sports scores", () => {
		for (const q of [
			"what's the score of the Lakers game right now",
			"who is winning the match",
			"live scores for the premier league",
			"final score of tonight's game",
		]) {
			expect(isUnservableLiveQuery(q)).toBe(true);
		}
	});

	it("does NOT fire on prices, exchange rates, place weather or headlines: Firecrawl serves today's figure (CUR-2424)", () => {
		for (const q of [
			"exchange rate between the euro and the Moroccan dirham today?",
			"USD to EUR exchange rate",
			"what is the current price of Bitcoin",
			"bitcoin price today",
			"what's the stock price of Tesla",
			"market cap of Nvidia right now",
			"what's the weather in Paris today",
			"today's weather forecast",
			"breaking news right now",
			"what's happening right now in the markets",
		]) {
			expect(isUnservableLiveQuery(q)).toBe(false);
		}
	});

	it("fires on weather with no place named, which no search can locate", () => {
		for (const q of ["is it raining outside", "is it snowing"]) {
			expect(isUnservableLiveQuery(q)).toBe(true);
		}
	});

	it("does NOT fire on servable recency / encyclopedic / scholarly queries", () => {
		for (const q of [
			"what is the latest news on the EU AI Act", // servable via Wikipedia; recency, not live
			"who won the 2022 World Cup", // past event, servable
			"biggest open models of 2025",
			"explain how a transformer attention head works",
			"what is the capital of France",
		]) {
			expect(isUnservableLiveQuery(q)).toBe(false);
		}
	});

	it("does NOT fire on METAPHORICAL 'who is winning' (a core query for an open-source-AI product)", () => {
		// Bare "who is winning" is metaphorical far too often here — it must not suppress a
		// manual/always search. Only a concrete sports-context noun ("the game/match/cup") fires.
		for (const q of [
			"who is winning the race to build open-source AI",
			"who is winning the AI policy debate",
			"who is winning the battle between open and closed models",
		]) {
			expect(isUnservableLiveQuery(q)).toBe(false);
		}
		// ...but an explicit sports context still fires.
		expect(isUnservableLiveQuery("who is winning the game")).toBe(true);
		expect(isUnservableLiveQuery("who is winning the World Cup final")).toBe(true);
	});

	it("does NOT false-fire on technical 'temperature'/'forecast' phrasings or idioms", () => {
		for (const q of [
			"how do I read the current temperature of my CPU", // hardware, not weather
			"what's our sales forecast for Q3", // business, not weather
			"how do I check my credit score", // not a live sports score
			"what were my test scores", // not a live score
		]) {
			expect(isUnservableLiveQuery(q)).toBe(false);
		}
	});

	it("does NOT fire on SOFTWARE 'live' phrasings (adjective, not a live-data ask)", () => {
		// "live" is a common UI/software term; these are servable/timeless engineering questions.
		for (const q of [
			"how do I implement live updates in SvelteKit", // "live updates" no longer in the pattern
			"design a live stream transcription pipeline", // "live stream" dropped
			"build a live results dashboard architecture", // "live results" dropped
			"live scores API integration guide", // matches "live scores" but de-noised by "api"
			"how do I show the current price field in my schema", // generic "current price" isn't a market-quote pattern (no stock/crypto/commodity)
		]) {
			expect(isUnservableLiveQuery(q)).toBe(false);
		}
	});

	it("does NOT fire on trivially short or empty drafts", () => {
		expect(isUnservableLiveQuery("")).toBe(false);
		expect(isUnservableLiveQuery("hi")).toBe(false);
	});
});

// isExplicitLookupRequest is LOOKUP_RE split out of isRecencyQuery so a caller (the margin trigger
// strategy) can trust the user's OWN stated ask to search independently of the topic-based RECENCY_RE
// half, which is deliberately NOT OR'd into margin (see triggerStrategy.spec.ts). Bundled into the
// excluded isRecencyQuery heuristic, a follow-up like the phrasings below matches LOOKUP_RE and is
// still silently discarded, so the turn never searches.
describe("isExplicitLookupRequest — the user's own stated ask to search", () => {
	it("fires on the documented look-it-up scenario (same phrasings as isRecencyQuery)", () => {
		expect(isExplicitLookupRequest("can you look that up for me")).toBe(true);
		expect(isExplicitLookupRequest("how do you find out which model is newest")).toBe(true);
		expect(isExplicitLookupRequest("please fact-check this claim")).toBe(true);
	});

	it("fires on the two frog-blast dogfood turns that were silently dropped", () => {
		expect(isExplicitLookupRequest("why not look online to find out?")).toBe(true);
		expect(isExplicitLookupRequest("can you check online for the steps")).toBe(true);
	});

	it("fires on check/verify/confirm ... online within a short gap", () => {
		expect(isExplicitLookupRequest("can you verify that online")).toBe(true);
		expect(isExplicitLookupRequest("confirm it online please")).toBe(true);
	});

	it("does NOT fire on timeless / training-answerable questions", () => {
		expect(isExplicitLookupRequest("explain how a transformer attention head works")).toBe(false);
		expect(isExplicitLookupRequest("what is the capital of France")).toBe(false);
		expect(isExplicitLookupRequest("check my code for bugs")).toBe(false);
	});

	it("does NOT fire on trivially short or empty drafts", () => {
		expect(isExplicitLookupRequest("")).toBe(false);
		expect(isExplicitLookupRequest("hi")).toBe(false);
	});
});

describe("asksForTheLatest: the newest of something, never just a year (CUR-3932)", () => {
	it.each([
		"What did the ECB decide at its most recent rate meeting?",
		"When was the most recent total solar eclipse visible in the US?",
		"Who won the latest FIFA World Cup?",
	])("asks for the latest: %s", (q) => expect(asksForTheLatest(q)).toBe(true));
	it.each(["Who won the 2024 US presidential election?", "how does the ECB set interest rates"])(
		"does not: %s",
		(q) => expect(asksForTheLatest(q)).toBe(false)
	);
});
