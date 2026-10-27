import { describe, it, expect, vi } from "vitest";

// Hermetic gate: stub $lib/chat/server/models so importing ./searchDecision doesn't trigger
// models.ts's import-time buildModels() live fetch (needs OPENAI_BASE_URL + network). The
// parse functions under test are pure; defaultModel is only read on the live decision paths.
vi.mock("$lib/chat/server/models", () => ({
	models: [],
	defaultModel: { id: "test-model", name: "test-model" },
	taskModel: { id: "test-model", name: "test-model" },
}));

import { parseClassifierVerdict, parseToolDecision } from "./searchDecision";
import { readClassifierVerdict } from "./classifierPrompt";

// The verdict parse is the load-bearing bit of the model classifier: it must
// fail CLOSED (→ no search) on anything that isn't a clean leading "yes", since
// a false-positive search costs latency + injects sources, while abstaining
// just answers from training.
describe("parseClassifierVerdict", () => {
	it("accepts a clean yes (any case, trailing punctuation/whitespace)", () => {
		expect(parseClassifierVerdict("yes")).toBe(true);
		expect(parseClassifierVerdict("Yes")).toBe(true);
		expect(parseClassifierVerdict("YES")).toBe(true);
		expect(parseClassifierVerdict("  yes  ")).toBe(true);
		expect(parseClassifierVerdict("yes.")).toBe(true);
		expect(parseClassifierVerdict("yes, current info needed")).toBe(true);
	});

	it("rejects no and fails closed on rambling / empty / leading non-yes", () => {
		expect(parseClassifierVerdict("no")).toBe(false);
		expect(parseClassifierVerdict("No.")).toBe(false);
		expect(parseClassifierVerdict("")).toBe(false);
		expect(parseClassifierVerdict(undefined)).toBe(false);
		expect(parseClassifierVerdict("I think yes")).toBe(false);
		expect(parseClassifierVerdict("maybe")).toBe(false);
		// must be the whole word, not a prefix like "yesterday"
		expect(parseClassifierVerdict("yesterday's news")).toBe(false);
	});
});

describe("readClassifierVerdict keeps a malformed reply apart from a real no (CUR-2141)", () => {
	it("reads yes and no by their leading word", () => {
		expect(readClassifierVerdict("Yes.")).toBe("yes");
		expect(readClassifierVerdict("  no  ")).toBe("no");
		expect(readClassifierVerdict("No, it is timeless")).toBe("no");
	});

	it("calls anything else malformed, including a word that only starts with yes or no", () => {
		expect(readClassifierVerdict("")).toBe("malformed");
		expect(readClassifierVerdict(undefined)).toBe("malformed");
		expect(readClassifierVerdict("I think yes")).toBe("malformed");
		expect(readClassifierVerdict("yesterday's news")).toBe("malformed");
		expect(readClassifierVerdict("nothing needed")).toBe("malformed");
	});
});

// The tool-decision parse turns the model's OpenAI tool_calls into {shouldSearch,
// query}. A web_search call → search (with the model's query when present); no
// call → no search. Shape mirrors the live probe (an Apertus tool-calling checkpoint).
describe("parseToolDecision", () => {
	const webSearchCall = (args: string) => [
		{ id: "x", type: "function", function: { name: "web_search", arguments: args } },
	];

	it("a web_search call with a query → search, carrying the model's query", () => {
		expect(parseToolDecision(webSearchCall('{"query": "latest news EU AI Act 2024"}'))).toEqual({
			shouldSearch: true,
			query: "latest news EU AI Act 2024",
		});
	});

	it("no tool call → no search (model answered from training)", () => {
		expect(parseToolDecision(null)).toEqual({ shouldSearch: false });
		expect(parseToolDecision([])).toEqual({ shouldSearch: false });
		expect(parseToolDecision(undefined)).toEqual({ shouldSearch: false });
	});

	it("only web_search counts — an unrelated tool call does not trigger search", () => {
		expect(parseToolDecision([{ function: { name: "some_other_tool", arguments: "{}" } }])).toEqual(
			{ shouldSearch: false }
		);
	});

	// openai v7 made tool_calls a union: a function call (has `function`) or a CUSTOM tool call, which
	// has no `function` property at all and carries a freeform `custom.input` instead. We never define
	// a custom tool, so this is unreachable in practice — the test exists because `ToolCallLike` had to
	// grow a `type` field to accept the union at all, and that made a shape with no `function` newly
	// representable. Pinning it as fail-closed, so the field cannot later be removed or the branch
	// quietly changed to guess "search".
	it("declines (fail closed) on a custom tool call, which carries no function to inspect", () => {
		// Built via a helper for the same reason webSearchCall above is: an inline object literal is
		// "fresh" and gets excess-property-checked against ToolCallLike, which deliberately models only
		// the fields this parser reads. The realistic shape matters more than the narrow type here.
		const customToolCall = () => [
			{ id: "x", type: "custom", custom: { name: "grammar", input: "..." } },
		];
		expect(parseToolDecision(customToolCall())).toEqual({ shouldSearch: false });
	});

	it("called but malformed/empty args → search, no query (caller falls back to raw text)", () => {
		expect(parseToolDecision(webSearchCall("not json"))).toEqual({ shouldSearch: true });
		expect(parseToolDecision(webSearchCall('{"query": "   "}'))).toEqual({ shouldSearch: true });
		expect(parseToolDecision(webSearchCall("{}"))).toEqual({ shouldSearch: true });
	});
});
