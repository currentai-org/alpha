import { describe, it, expect } from "vitest";
import { extractInlineToolCallArgs, rawToolCallArgs } from "./forcedToolCallLane";

describe("extractInlineToolCallArgs", () => {
	it("extracts args from Apertus's real observed <|tools_prefix|> shape", () => {
		const content =
			'I\'ll use the calculateTime tool to add 19 minutes to 09:30.<|tools_prefix|>[{"calculateTime": {"baseTime": "09:30", "deltaMinutes": 19, "reasoning": "Adding 19 minutes to 09:30"}}]';
		const args = extractInlineToolCallArgs(content, "calculateTime");
		expect(args && JSON.parse(args)).toEqual({ baseTime: "09:30", deltaMinutes: 19, reasoning: "Adding 19 minutes to 09:30" });
	});

	it("returns undefined when the marker is absent", () => {
		expect(extractInlineToolCallArgs("just a plain answer, no tool call", "calculateTime")).toBeUndefined();
	});

	it("returns undefined when the marker's JSON doesn't include the requested tool name", () => {
		const content = '<|tools_prefix|>[{"calculate": {"expression": "1+1"}}]';
		expect(extractInlineToolCallArgs(content, "calculateTime")).toBeUndefined();
	});

	it("returns undefined on malformed JSON after the marker", () => {
		expect(extractInlineToolCallArgs("<|tools_prefix|>not json", "calculateTime")).toBeUndefined();
	});

	it("returns undefined on null/empty content", () => {
		expect(extractInlineToolCallArgs(null, "calculateTime")).toBeUndefined();
		expect(extractInlineToolCallArgs("", "calculateTime")).toBeUndefined();
		expect(extractInlineToolCallArgs(undefined, "calculateTime")).toBeUndefined();
	});

	// brackets, braces and escaped quotes inside a string argument are text, not structure. (CUR-2151)
	it("keeps a string argument whole when it contains ], }, [ and an escaped quote", () => {
		const reasoning = 'the list [a, b] ends here] and {x} } then a "quote"';
		const content = `Sure.<|tools_prefix|>[{"calculateTime": {"baseTime": "09:30", "reasoning": ${JSON.stringify(reasoning)}}}]<|tools_suffix|>`;
		const args = extractInlineToolCallArgs(content, "calculateTime");
		expect(args && JSON.parse(args)).toEqual({ baseTime: "09:30", reasoning });
	});

	it("stops at the array's real end when prose with brackets follows and no suffix arrived", () => {
		const content = '<|tools_prefix|>[{"calculateTime": {"baseTime": "09:30", "reasoning": "a ] b"}}] and then [more] text';
		const args = extractInlineToolCallArgs(content, "calculateTime");
		expect(args && JSON.parse(args)).toEqual({ baseTime: "09:30", reasoning: "a ] b" });
	});

	it("returns undefined (never a partial guess) when the array is truncated before it closes", () => {
		const content = '<|tools_prefix|>[{"calculateTime": {"baseTime": "09:30", "reasoning": "cut off ]';
		expect(extractInlineToolCallArgs(content, "calculateTime")).toBeUndefined();
	});

	it("finds the right entry among multiple tool calls in the array", () => {
		const content = '<|tools_prefix|>[{"otherTool": {"x": 1}}, {"calculateTime": {"baseTime": "10:00", "deltaMinutes": 5}}]';
		const args = extractInlineToolCallArgs(content, "calculateTime");
		expect(args && JSON.parse(args)).toEqual({ baseTime: "10:00", deltaMinutes: 5 });
	});
});

describe("rawToolCallArgs", () => {
	it("prefers a structured tool_calls entry over the inline marker", () => {
		const message = {
			tool_calls: [{ type: "function", function: { name: "calculateTime", arguments: '{"baseTime":"01:00"}' } }],
			content: '<|tools_prefix|>[{"calculateTime": {"baseTime": "99:99"}}]',
		};
		expect(rawToolCallArgs(message, "calculateTime")).toBe('{"baseTime":"01:00"}');
	});

	it("falls back to the inline marker when tool_calls is absent", () => {
		const message = { content: '<|tools_prefix|>[{"calculateTime": {"baseTime": "09:30", "deltaMinutes": 19}}]' };
		const args = rawToolCallArgs(message, "calculateTime");
		expect(args && JSON.parse(args)).toEqual({ baseTime: "09:30", deltaMinutes: 19 });
	});

	it("falls back to the inline marker when tool_calls is present but empty", () => {
		const message = { tool_calls: [], content: '<|tools_prefix|>[{"calculateTime": {"baseTime": "09:30"}}]' };
		expect(rawToolCallArgs(message, "calculateTime")).toBeDefined();
	});

	it("returns undefined when neither path has anything", () => {
		expect(rawToolCallArgs({ content: "plain prose" }, "calculateTime")).toBeUndefined();
		expect(rawToolCallArgs(undefined, "calculateTime")).toBeUndefined();
	});
});
