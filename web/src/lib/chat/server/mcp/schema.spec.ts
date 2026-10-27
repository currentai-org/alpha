import { describe, it, expect } from "vitest";
import {
	PLACEHOLDER_PARAM,
	isNoParamTool,
	mcpToolToOpenAITool,
	stripPlaceholderArgs,
	parseToolArgs,
	ensureParamDescriptions,
	type McpTool,
} from "./schema";

const withParams: McpTool = {
	name: "translate",
	description: "Translate text.",
	inputSchema: {
		type: "object",
		properties: { text: { type: "string" }, target: { type: "string" } },
		required: ["text", "target"],
	},
};
const noParams: McpTool = {
	name: "get_status",
	description: "Service status.",
	inputSchema: { type: "object", properties: {} },
};
const noSchema: McpTool = { name: "ping" };

describe("isNoParamTool", () => {
	it("detects empty / missing properties", () => {
		expect(isNoParamTool(noParams)).toBe(true);
		expect(isNoParamTool(noSchema)).toBe(true);
		expect(isNoParamTool(withParams)).toBe(false);
	});
});

describe("mcpToolToOpenAITool", () => {
	it("passes through real params + required", () => {
		const t = mcpToolToOpenAITool(withParams);
		expect(t.type).toBe("function");
		expect(t.function.name).toBe("translate");
		const p = t.function.parameters as { properties: Record<string, unknown>; required?: string[] };
		expect(Object.keys(p.properties)).toEqual(["text", "target"]);
		expect(p.required).toEqual(["text", "target"]);
	});

	it("pads a no-param tool with the placeholder arg (the no-param-tool workaround)", () => {
		const t = mcpToolToOpenAITool(noParams);
		const p = t.function.parameters as { properties: Record<string, unknown>; required?: string[] };
		expect(Object.keys(p.properties)).toEqual([PLACEHOLDER_PARAM]);
		expect(p.required).toBeUndefined(); // placeholder is optional
	});

	it("pads a tool with no input schema at all", () => {
		const p = mcpToolToOpenAITool(noSchema).function.parameters as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(p.properties)).toEqual([PLACEHOLDER_PARAM]);
	});
});

describe("stripPlaceholderArgs", () => {
	it("removes the placeholder pad before the Space sees it", () => {
		expect(stripPlaceholderArgs({ [PLACEHOLDER_PARAM]: "", text: "hi" })).toEqual({ text: "hi" });
		expect(stripPlaceholderArgs({ text: "hi" })).toEqual({ text: "hi" }); // untouched when absent
	});
});

describe("parseToolArgs", () => {
	it("parses JSON, fails safe to {} on junk/empty", () => {
		expect(parseToolArgs('{"text":"hi"}')).toEqual({ text: "hi" });
		expect(parseToolArgs(undefined)).toEqual({});
		expect(parseToolArgs("not json")).toEqual({});
		expect(parseToolArgs("[1,2]")).toEqual({}); // array is not a param object
	});
});

// ensureParamDescriptions exists because a
// param without a `description` key 400s the CSCS tool-use chat template ("'dict object' has no
// attribute 'description'"), which fails tool-calling open to no-tool on every routed turn. A
// production workaround with no test is one refactor away from silently reverting.
//
// Its live counterpart (spaceContract.live.spec.ts) CANNOT cover this: the Space we point at already
// supplies descriptions itself, so the workaround is a no-op against real data and removing it does not
// fail that spec. Hence hermetic tests here.
describe("ensureParamDescriptions", () => {
	it("injects the missing key, defaulting to the param name", () => {
		const out = ensureParamDescriptions({ text_input: { type: "string" } }) as Record<
			string,
			{ description?: string }
		>;
		expect(typeof out.text_input.description).toBe("string");
		expect(out.text_input.description!.length).toBeGreaterThan(0);
	});

	it("leaves an existing description alone", () => {
		const out = ensureParamDescriptions({
			text: { type: "string", description: "The text to read aloud." },
		}) as Record<string, { description?: string }>;
		expect(out.text.description).toBe("The text to read aloud.");
	});

	it("covers EVERY param, not just the first — one bare param is enough to 400 the request", () => {
		const out = ensureParamDescriptions({
			a: { type: "string", description: "has one" },
			b: { type: "number" },
			c: { type: "boolean" },
		}) as Record<string, { description?: string }>;
		for (const k of ["a", "b", "c"]) expect(typeof out[k].description).toBe("string");
	});

	// Pins the KNOWN LIMITATION rather than pretending it does not exist. schema.ts says "Shallow by
	// design — Gradio tool params are flat; recurse here if a nested-object param ever needs it." This
	// test documents exactly what that costs, so whoever adds a nested param finds a failing test that
	// explains itself instead of a 400 in prod.
	it("does NOT recurse — a nested object property keeps no description (known, and it 400s)", () => {
		const out = ensureParamDescriptions({
			opts: { type: "object", properties: { voice: { type: "string" } } },
		}) as Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
		expect(typeof out.opts.description).toBe("string"); // top level padded
		expect(out.opts.properties!.voice.description).toBeUndefined(); // nested is NOT
	});
});
