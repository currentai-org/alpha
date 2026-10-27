import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { estimateMessageTokens, fitHistory, MessageTooLongError, overContextBeforeScreen } from "./fitHistory";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// 400 ASCII bytes is 100 trimming-count tokens of content, plus 8 for the message.
const text = (tag: string) => tag + "x".repeat(400 - tag.length);
const user = (tag: string): Msg => ({ role: "user", content: text(tag) });
const assistant = (tag: string): Msg => ({ role: "assistant", content: text(tag) });
const system: Msg = { role: "system", content: text("sys") };

const chat = (pairs: number): Msg[] => {
	const out: Msg[] = [system];
	for (let i = 1; i <= pairs; i++) out.push(user(`q${i}`), assistant(`a${i}`));
	out.push(user("newest"));
	return out;
};
const tags = (msgs: Msg[]) => msgs.map((m) => String(m.content).replace(/x+$/, ""));

describe("fitHistory", () => {
	it("returns the same array, untouched, when the chat already fits", () => {
		const msgs = chat(3);
		const before = JSON.stringify(msgs);
		const fit = fitHistory(msgs, { contextTokens: 10_000, reserveTokens: 1_000 });
		expect(fit).toEqual({ kind: "fits", messages: msgs, leftOut: 0 });
		if (fit.kind === "fits") expect(fit.messages).toBe(msgs);
		expect(JSON.stringify(msgs)).toBe(before);
	});

	it("drops the oldest exchanges first and always keeps the system prompt and newest message", () => {
		// 8 messages at 108 each = 864. Budget 600 keeps system + newest (216) and three more messages'
		// worth of room (384): one full exchange (216), not two (432).
		const fit = fitHistory(chat(3), { contextTokens: 700, reserveTokens: 100 });
		expect(fit.kind).toBe("fits");
		if (fit.kind !== "fits") return;
		expect(tags(fit.messages)).toEqual(["sys", "q3", "a3", "newest"]);
		expect(fit.leftOut).toBe(2);
	});

	it("reserves the answer's max_tokens out of the context", () => {
		const roomy = fitHistory(chat(3), { contextTokens: 1_000, reserveTokens: 0 });
		const reserved = fitHistory(chat(3), { contextTokens: 1_000, reserveTokens: 500 });
		expect(roomy.kind === "fits" && roomy.leftOut).toBe(0);
		expect(reserved.kind === "fits" && reserved.leftOut).toBe(2);
	});

	it("refuses (overflow, no messages) when the newest message alone is over budget", () => {
		const msgs: Msg[] = [system, user("q1"), assistant("a1"), { role: "user", content: "y".repeat(30_000) }];
		const fit = fitHistory(msgs, { contextTokens: 5_000, reserveTokens: 1_000 });
		// At the refusing count, 5 bytes a token: system 80 + 8, newest 6,000 + 8.
		expect(fit).toEqual({ kind: "overflow", requiredTokens: 88 + 6_008, budgetTokens: 4_000 });
	});

	it("never splits an exchange, so a tool result stays with the call that asked for it", () => {
		const call: Msg = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "calculate", arguments: "{}" } }],
		};
		const result: Msg = { role: "tool", tool_call_id: "c1", content: text("r") };
		const msgs: Msg[] = [system, user("q1"), call, result, assistant("a1"), user("q2"), assistant("a2"), user("newest")];
		// Room for q2/a2 (216) but not the four-message q1 exchange as well.
		const fit = fitHistory(msgs, { contextTokens: 500, reserveTokens: 0 });
		expect(fit.kind === "fits" && fit.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
		const wider = fitHistory(msgs, { contextTokens: 900, reserveTokens: 0 });
		expect(wider.kind === "fits" && wider.messages).toBe(msgs);
	});

	it("counts UTF-8 bytes, so a CJK character costs three times an ASCII one", () => {
		const cjk = estimateMessageTokens({ role: "user", content: "漢".repeat(400) });
		expect(cjk).toBe(8 + 300);
	});

	// Apertus counts this size of English document as 20,548 tokens, and it answers
	// on a 32000-token lane. A refusal here would turn away a working request.
	it("sends a full 100,000-byte English document on a 32000-token lane, refusing nothing", () => {
		const doc: Msg = { role: "user", content: "It is a truth universally acknowledged. ".repeat(2_500) };
		const msgs: Msg[] = [system, user("q1"), assistant("a1"), doc];
		const fit = fitHistory(msgs, { contextTokens: 32_000, reserveTokens: 4_096 });
		expect(fit.kind).toBe("fits");
	});

	it("sends the required part alone, not a refusal, when only the trimming count says it is over", () => {
		// 120,000 bytes: 30,008 at 4 bytes a token (over 27,904), 24,008 at 5 (under it).
		const big: Msg = { role: "user", content: "w".repeat(120_000) };
		const fit = fitHistory([system, user("q1"), assistant("a1"), big], {
			contextTokens: 32_000,
			reserveTokens: 4_096,
		});
		expect(fit.kind === "fits" && fit.messages).toEqual([system, big]);
		expect(fit.kind === "fits" && fit.leftOut).toBe(1);
	});

	it("charges each image a flat 1,600 tokens", () => {
		const withImage = estimateMessageTokens({
			role: "user",
			content: [
				{ type: "text", text: "abc" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
			],
		});
		expect(withImage).toBe(8 + 1 + 1_600);
	});
});

describe("overContextBeforeScreen", () => {
	const cjk = "春眠不覚暁処処聞啼鳥夜来風雨声花落知多少".repeat(5_000);

	it("refuses a 100,000-character CJK paste on a 32000-token lane before the screen runs", () => {
		const refused = overContextBeforeScreen(cjk, 0, 32_000);
		expect(refused).toBeInstanceOf(MessageTooLongError);
		expect(refused?.requiredTokens).toBe(60_008);
	});

	it("lets a full 100,000-byte English paste through to the screen on a 32000-token lane", () => {
		expect(overContextBeforeScreen("x".repeat(100_000), 0, 32_000)).toBeNull();
	});

	it("never refuses what the endpoint would send: anything it refuses, fitHistory refuses too", () => {
		for (const length of [128_000, 140_000, 159_960, 159_961, 160_000, 200_000]) {
			const message = "x".repeat(length);
			if (!overContextBeforeScreen(message, 0, 32_000)) continue;
			const fit = fitHistory([system, { role: "user", content: message }], { contextTokens: 32_000, reserveTokens: 0 });
			expect(fit.kind, `${length} bytes`).toBe("overflow");
		}
		expect(overContextBeforeScreen("x".repeat(159_960), 0, 32_000), "exactly at the line is left to the endpoint").toBeNull();
	});

	it("counts each attached image at the endpoint's flat 1,600 tokens", () => {
		expect(overContextBeforeScreen("hi", 19, 32_000)).toBeNull();
		expect(overContextBeforeScreen("hi", 20, 32_000)).toBeInstanceOf(MessageTooLongError);
	});
});
