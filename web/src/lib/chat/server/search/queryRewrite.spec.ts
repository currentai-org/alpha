import { describe, it, expect, vi, afterEach } from "vitest";
import { needsContextualization, contentTokenCount, sanitizeRewrite, contextualizeQuery } from "./queryRewrite";

vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

// The cases below are GENERIC STAND-INS shaped like real zero-citation queries, not the original
// text. Anything asserted here is reproducible from the shape alone, so the spec does not depend on
// data it cannot carry.

describe("needsContextualization", () => {
	it("flags dangling referential pronouns", () => {
		expect(needsContextualization("what most recent research says about it?")).toBe(true);
		expect(needsContextualization("how does that work")).toBe(true);
		expect(needsContextualization("are they still around")).toBe(true);
		expect(needsContextualization("tell me about the second one")).toBe(true);
	});

	it("flags continuation fragments", () => {
		expect(needsContextualization("and the latest version?")).toBe(true);
		expect(needsContextualization("what about funding")).toBe(true);
		expect(needsContextualization("tell me more")).toBe(true);
	});

	it("leaves a self-contained query alone", () => {
		expect(needsContextualization("what is the biggest dinosaur ever")).toBe(false);
		expect(needsContextualization("current status of the EU AI Act")).toBe(false);
		expect(needsContextualization("open-source vector databases")).toBe(false);
		expect(needsContextualization("")).toBe(false);
	});

	// Named for the CONTRACT — "a query carrying no topic must not
	// reach the engines verbatim" — rather than for the regex, because the regex is the thing most
	// likely to be rewritten and the contract is what has to survive that.

	it("flags a bare reply or topicless imperative — searching it verbatim can only retrieve on the wrong sense", () => {
		// Each of these retrieved a real, confidently-wrong sense in production: an affirmative matched
		// a band, a product-shaped imperative matched a product review, a repeat-request matched a song.
		expect(needsContextualization("yes")).toBe(true);
		expect(needsContextualization("ok")).toBe(true);
		expect(needsContextualization("try now")).toBe(true);
		expect(needsContextualization("search again")).toBe(true);
		expect(needsContextualization("go ahead")).toBe(true);
	});

	it("flags a topicless imperative whose tail is only a CHANNEL, not a subject", () => {
		expect(needsContextualization("double check on the web")).toBe(true);
		expect(needsContextualization("search again online")).toBe(true);
		expect(needsContextualization("verify that for me")).toBe(true);
		expect(needsContextualization("look it up")).toBe(true);
	});

	it("does NOT flag the same imperatives when they carry a topic", () => {
		// The regression guard for this rule. Gating on a content-token floor fires on
		// both of the first two, which name a subject and search correctly as written. If this
		// test ever passes because the rule stopped firing at all, the previous test catches that.
		expect(needsContextualization("search for Apertus 1.5 benchmarks")).toBe(false);
		expect(needsContextualization("tell me about the Digital Omnibus")).toBe(false);
		expect(needsContextualization("check the EU AI Act penalty ceilings")).toBe(false);
		expect(needsContextualization("verify the Swiss AI Act timeline")).toBe(false);
	});

	it("flags non-English referentials — the gate runs on every language, the pronoun list was English-only", () => {
		expect(needsContextualization("et à l'ONU")).toBe(true);
		expect(needsContextualization("et aussi les autres")).toBe(true);
		expect(needsContextualization("y también eso")).toBe(true);
		expect(needsContextualization("und was dazu")).toBe(true);
	});

	it("flags a query that reduces to almost no content once function words are stripped", () => {
		expect(contentTokenCount("what are your actual sources")).toBeLessThan(2);
		expect(needsContextualization("what are your actual sources")).toBe(true);
		// "model" survives the strip, which is exactly the token that retrieved modelling quizzes.
		expect(contentTokenCount("what model are you, exactly")).toBeLessThan(2);
		expect(needsContextualization("what model are you, exactly")).toBe(true);
	});

	it("keeps a short but genuinely specific query out of the rewrite path", () => {
		// The floor is 2 content tokens, so this is where it must NOT bite: a terse query that names
		// something is the common case and must still search with zero added latency.
		expect(needsContextualization("2026 World Cup winner")).toBe(false);
		expect(needsContextualization("population of Zurich")).toBe(false);
		expect(needsContextualization("Apertus 70B model card")).toBe(false);
		expect(needsContextualization("Ecuador news today")).toBe(false);
	});
});

describe("sanitizeRewrite", () => {
	const fb = "raw query";

	it("strips surrounding quotes and labels", () => {
		expect(sanitizeRewrite('"biggest dinosaur ever"', fb)).toBe("biggest dinosaur ever");
		expect(sanitizeRewrite("Standalone search query: biggest dinosaur", fb)).toBe(
			"biggest dinosaur"
		);
	});

	it("keeps only the first line when the model rambles", () => {
		expect(sanitizeRewrite("biggest dinosaur ever\nThis resolves 'it' to the dinosaur.", fb)).toBe(
			"biggest dinosaur ever"
		);
	});

	it("falls back on empty or over-long output", () => {
		expect(sanitizeRewrite("", fb)).toBe(fb);
		expect(sanitizeRewrite("   ", fb)).toBe(fb);
		expect(sanitizeRewrite("x".repeat(250), fb)).toBe(fb);
	});

	it("passes a clean standalone rewrite through unchanged", () => {
		expect(sanitizeRewrite("most recent research on Argentinosaurus size", fb)).toBe(
			"most recent research on Argentinosaurus size"
		);
	});
});

describe("contextualizeQuery bounds its model call", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("$lib/chat/server/generateFromDefaultEndpoint");
		vi.clearAllMocks();
	});

	it(
		"falls back to the raw query when the rewrite never answers, instead of hanging the turn (CUR-1655)",
		async () => {
			// Without a bound, a rewrite that never answers would hold the turn until the 45s watchdog.
			// The contract is that the caller returns the raw query on its own.
			vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
				// eslint-disable-next-line require-yield -- deliberately never settles, to prove the bound fires
				generateFromDefaultEndpoint: async function* () {
					await new Promise(() => {});
					return "unreachable";
				},
			}));
			const raw = "and what about the second one";
			const history = [
				{ from: "user" as const, content: "who designed the Sydney Opera House" },
				{ from: "assistant" as const, content: "Jorn Utzon." },
			];
			// Real timers: a faked clock does not reliably interleave with the dynamic import and async
			// generator this path goes through. REWRITE_TIMEOUT_MS is 5000ms.
			await expect(contextualizeQuery(raw, history, undefined)).resolves.toBe(raw);
		},
		15000
	);
});

describe("contextualizeQuery reports where the rewrite ran, from the call's own record (CUR-3563)", () => {
	afterEach(() => {
		vi.doUnmock("$lib/chat/server/generateFromDefaultEndpoint");
	});
	const history = [
		{ from: "user" as const, content: "who designed the Sydney Opera House" },
		{ from: "assistant" as const, content: "Jorn Utzon." },
	];

	it("hands back the served model, backend and provider the endpoint reported", async () => {
		vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
			// eslint-disable-next-line require-yield -- a side call that answers in one return
			generateFromDefaultEndpoint: async function* (o: { onServed?: (s: object) => void }) {
				o.onServed?.({ requestedModel: "task-model" });
				o.onServed?.({ model: "served-model", backend: "https://gw.example.org/v1", provider: "" });
				return "Jorn Utzon other buildings";
			},
		}));
		const onAnswered = vi.fn();
		await contextualizeQuery("and what else did he design", history, undefined, onAnswered);
		expect(onAnswered).toHaveBeenCalledWith({
			requestedModel: "task-model",
			model: "served-model",
			backend: "https://gw.example.org/v1",
		});
	});

	it("reports nothing when the rewrite call failed, so the receipt never names a model that did not answer", async () => {
		vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
			// eslint-disable-next-line require-yield -- a side call that fails in one return
			generateFromDefaultEndpoint: async function* (o: {
				onServed?: (s: object) => void;
				onFailure?: (k: "error") => void;
			}) {
				o.onServed?.({ requestedModel: "task-model" });
				o.onFailure?.("error");
				return "";
			},
		}));
		const onAnswered = vi.fn();
		await contextualizeQuery("and what else did he design", history, undefined, onAnswered);
		expect(onAnswered).not.toHaveBeenCalled();
	});
});
