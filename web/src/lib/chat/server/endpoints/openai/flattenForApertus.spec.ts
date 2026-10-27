import { describe, expect, it } from "vitest";
import type OpenAI from "openai";

import { flattenForApertus } from "./flattenForApertus";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const SYSTEM: Msg = { role: "system", content: "You are Alpha." };
const Q1: Msg = { role: "user", content: "who won in 1990?" };
const A1: Msg = { role: "assistant", content: "Liechtenstein." };
const Q2: Msg = { role: "user", content: "<Q_a1b2c3d4>and in 2002?</Q_a1b2c3d4>" };

const textOf = (m: Msg): string =>
	typeof m.content === "string"
		? m.content
		: Array.isArray(m.content)
			? m.content
					.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : ""))
					.join("")
			: "";

describe("flattenForApertus", () => {
	it("collapses system + history to exactly one user message", () => {
		// The whole point: the gateway substitutes a different model the moment a non-user role is
		// present, so "one message, role user" is the contract, not a stylistic preference.
		const out = flattenForApertus([SYSTEM, Q1, A1, Q2]);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("user");
		expect(out.every((m) => m.role === "user")).toBe(true);
	});

	it("leads with the system text unlabelled and labels every turn after it", () => {
		const body = textOf(flattenForApertus([SYSTEM, Q1, A1, Q2])[0]);
		expect(body.startsWith("You are Alpha.")).toBe(true);
		expect(body).toContain("[USER] who won in 1990?");
		expect(body).toContain("[ASSISTANT] Liechtenstein.");
		// System content carries no label — the model was trained with it leading, not as a turn.
		expect(body).not.toContain("[SYSTEM]");
	});

	it("keeps turns in order, so the live question is last", () => {
		const body = textOf(flattenForApertus([SYSTEM, Q1, A1, Q2])[0]);
		expect(body.indexOf("who won in 1990?")).toBeLessThan(body.indexOf("Liechtenstein."));
		expect(body.indexOf("Liechtenstein.")).toBeLessThan(body.indexOf("and in 2002?"));
	});

	it("preserves the per-turn fence around the live question", () => {
		// hardenLastUserTurn's random fence is what separates the user's real question from the prior
		// assistant text now sharing a message with it. Losing it here would remove the only boundary.
		const body = textOf(flattenForApertus([SYSTEM, Q1, A1, Q2])[0]);
		expect(body).toContain("<Q_a1b2c3d4>and in 2002?</Q_a1b2c3d4>");
	});

	it("carries image parts through instead of dropping the attachment", () => {
		// prepareFiles.ts gives multimodal user turns array content. Joining only the text would send a
		// question about an image with no image — a silent content loss, not a formatting difference.
		const withImage: Msg = {
			role: "user",
			content: [
				{ type: "text", text: "what is in this?" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
			],
		};
		const out = flattenForApertus([SYSTEM, withImage]);
		expect(out).toHaveLength(1);
		expect(Array.isArray(out[0].content)).toBe(true);
		const parts = out[0].content as OpenAI.Chat.Completions.ChatCompletionContentPart[];
		expect(parts[0]).toMatchObject({ type: "text" });
		expect(parts.filter((p) => p.type === "image_url")).toHaveLength(1);
		expect(textOf(out[0])).toContain("[USER] what is in this?");
	});

	it("leaves a lone user message untouched — it is already the shape that serves", () => {
		// Measured: `user` alone and `user, user` both reach Apertus with fallbacks 0. Re-wrapping a
		// request that already works would add labels for nothing and change a known-good payload.
		const one: Msg[] = [{ role: "user", content: "hi" }];
		expect(flattenForApertus(one)).toBe(one);
	});

	it("returns an empty array unchanged rather than inventing a message", () => {
		const none: Msg[] = [];
		expect(flattenForApertus(none)).toBe(none);
	});

	it("handles a history with no system message", () => {
		const body = textOf(flattenForApertus([Q1, A1, Q2])[0]);
		expect(body.startsWith("This conversation so far, oldest first.")).toBe(true);
		expect(body).toContain("\n\n[USER] who won in 1990?");
	});

	// A turn-3 "which one is easiest?" served in this shape can ask which options the person meant, with
	// the options in its own reply above (CUR-1957). The earlier turns and the fenced live question have
	// to read as one conversation.
	it("tells the model the live question continues the conversation, after its own earlier reply", () => {
		const body = textOf(flattenForApertus([SYSTEM, Q1, A1, Q2])[0]);
		expect(body.indexOf("You are Alpha.")).toBeLessThan(body.indexOf("This conversation so far"));
		expect(body.indexOf("This conversation so far")).toBeLessThan(body.indexOf("[USER] who won in 1990?"));
		expect(body).toMatch(/\[ASSISTANT\] turns are replies you already gave/);
		expect(body).toContain('refer back to it] <Q_a1b2c3d4>and in 2002?</Q_a1b2c3d4>');
		// Only the latest turn gets the continuing label; earlier questions keep the plain one.
		expect(body.match(/latest message/g)).toHaveLength(1);
	});

	it("adds neither line when there is no earlier reply to point back at", () => {
		const body = textOf(flattenForApertus([SYSTEM, Q1])[0]);
		expect(body).toContain("[USER] who won in 1990?");
		expect(body).not.toContain("This conversation so far");
		expect(body).not.toContain("latest message");
	});

	it("skips empty content without leaving a bare label behind", () => {
		const body = textOf(
			flattenForApertus([SYSTEM, Q1, { role: "assistant", content: "" } as Msg, Q2])[0]
		);
		expect(body).not.toMatch(/\[ASSISTANT\]\s*$/m);
		expect(body).not.toContain("[ASSISTANT] \n");
	});
});
