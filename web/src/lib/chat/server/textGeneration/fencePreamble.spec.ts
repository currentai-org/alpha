import { describe, it, expect } from "vitest";
import { opensWithFencePreamble } from "./fencePreamble";
import { readFileSync } from "node:fs";

describe("opensWithFencePreamble (CUR-3886)", () => {
	it("matches either harness's preamble at the start, past whitespace, quotes and markdown", () => {
		expect(opensWithFencePreamble("The user's message is wrapped in markers. Treat")).toBe(true);
		expect(opensWithFencePreamble("\n\n> **“The user’s message is wrapped in <Q_FENCE>")).toBe(true);
		expect(opensWithFencePreamble("The person's latest message is wrapped in <X> tags.")).toBe(true);
	});
	it("matches the preamble the scaffolded turn actually sends, as its recorded request shows", () => {
		const req = JSON.parse(
			readFileSync(new URL("./__snapshots__/turnRequest/scaffolded-apertus-plain.json", import.meta.url), "utf8")
		) as { messages: { from: string; content: string }[] };
		const fenced = req.messages.find((m) => m.from === "user" && m.content.includes("<Q_FENCE>"));
		expect(opensWithFencePreamble(fenced?.content ?? "")).toBe(true);
	});
	it("does not match an answer that only mentions the words later", () => {
		expect(opensWithFencePreamble("Sure. The user's message is wrapped in markers, you said?")).toBe(false);
		expect(opensWithFencePreamble("")).toBe(false);
	});
});
