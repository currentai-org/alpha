import { describe, expect, it } from "vitest";
import { describeRequest } from "./requestLog";

import { redactLogObject } from "$lib/chat/server/logRedaction";

const SYSTEM = "You are Mistral Large 4.\n\nBackground about you for this turn.\n\nAnswer briefly.";
const USER = "What is the capital of Japan? my secret is hunter2";

const body = (system = SYSTEM, extra: Record<string, unknown> = {}) => ({
	model: "mistral-large-2610",
	stream: true,
	max_tokens: 16384,
	tool_choice: "auto",
	tools: [{ type: "function", function: { name: "web_search", parameters: {} } }],
	messages: [
		{ role: "system", content: system },
		{ role: "user", content: USER },
	],
	disable_fallbacks: true,
	...extra,
});
const headers = {
	"ChatUI-Conversation-ID": "65f0c0ffee",
	"ChatUI-Serves-User-Answer": "1",
	"X-use-cache": "false",
	Authorization: "Bearer sk-live-should-never-appear",
};

describe("the [request] sent line", () => {
	it("on production or an undeclared deployment carries no message text, no body and no paragraph hashes", () => {
		const line = JSON.stringify(describeRequest(body(), headers, false));
		expect(line).not.toContain("Japan");
		expect(line).not.toContain("hunter2");
		expect(line).not.toContain("Background about you");
		expect(line).not.toContain("sentRequest");
		expect(line).not.toContain("systemParagraphHashes");
	});

	it("on production still says what shaped the request: params, tools, roles with lengths, headers by name", () => {
		const line = describeRequest(body(), headers, false);
		expect(line.params).toEqual({
			model: "mistral-large-2610",
			stream: true,
			max_tokens: 16384,
			disable_fallbacks: true,
		});
		expect(line.tools).toEqual(["web_search"]);
		expect(line.toolChoice).toBe("auto");
		expect(line.turns).toEqual([`system:${SYSTEM.length}`, `user:${USER.length}`]);
		expect(line.systemChars).toBe(SYSTEM.length);
		expect(line.systemParagraphChars).toEqual([24, 35, 15]);
		expect(line.bodyKeys).toEqual(["disable_fallbacks", "max_tokens", "messages", "model", "stream", "tool_choice", "tools"]);
	});

	it("never logs a credential or the conversation id, on any deployment", () => {
		for (const full of [false, true]) {
			const line = describeRequest(body(), headers, full);
			expect(line.headers).toEqual([
				"ChatUI-Conversation-ID=<set>",
				"ChatUI-Serves-User-Answer=1",
				"X-use-cache=false",
				"Authorization=<set>",
			]);
		}
	});

	it("never carries a message's text in any field, on production or on preview", () => {
		// A sentence that appears in no field name, hash or length, placed in every place a body holds text.
		const SENTENCE = "The heron counted seventeen violet lanterns before dawn";
		const sent = body(`You are Mistral Large 4.\n\n${SENTENCE} (system).`, {
			messages: [
				{ role: "system", content: `You are Mistral Large 4.\n\n${SENTENCE} (system).` },
				{ role: "user", content: [{ type: "text", text: `${SENTENCE} (user part).` }] },
				{
					role: "assistant",
					content: `${SENTENCE} (assistant).`,
					tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: JSON.stringify({ q: SENTENCE }) } }],
				},
				{ role: "tool", tool_call_id: "c1", content: `${SENTENCE} (tool result).` },
			],
			prompt: `${SENTENCE} (completions prompt).`,
		});
		for (const full of [false, true]) {
			const line = describeRequest(sent, headers, full);
			const leaking = Object.entries(line)
				.filter(([, value]) => JSON.stringify(value ?? null).includes("violet lanterns"))
				.map(([key]) => key);
			expect({ full, leaking }).toEqual({ full, leaking: [] });
		}
	});

	it("names the one system paragraph that differs between two requests by its hash", () => {
		const a = describeRequest(body(), headers, true).systemParagraphHashes as string[];
		const b = describeRequest(body(SYSTEM.replace("Answer briefly.", "Answer at length.")), headers, true)
			.systemParagraphHashes as string[];
		expect(a.map((h, i) => h === b[i])).toEqual([true, true, false]);
	});

	it("gives the logger's content redaction nothing to redact, on production or on preview", () => {
		for (const full of [false, true]) {
			const line = describeRequest(body(), headers, full);
			expect(redactLogObject(line)).toEqual(line);
		}
	});
});
