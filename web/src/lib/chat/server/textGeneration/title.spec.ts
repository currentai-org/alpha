/**
 * Title selection must never name a conversation after a moderation-declined (toxic / child-safety)
 * message. Title gen runs on a later clean turn, so it must not title from the FIRST user message: a
 * flagged opening message would put toxic text into the sidebar title. firstAnsweredUserMessage skips
 * declined turns (the assistant reply carries moderation.flagged) and only titles from a turn that
 * produced a real answer.
 */
import { describe, expect, it, vi } from "vitest";

// Hermetic gate: stub $lib/chat/server/models so importing ./title (→ generateFromDefaultEndpoint
// → models) doesn't trigger models.ts's import-time buildModels() live fetch. firstAnsweredUserMessage
// is pure; models/taskModel are only used on the live generation path.
vi.mock("$lib/chat/server/models", () => ({
	models: [],
	defaultModel: { id: "test-model", name: "test-model" },
	taskModel: { id: "test-model", name: "test-model" },
}));

import {
	classifyTitle,
	firstAnsweredUserMessage,
	firstFiveWords,
	looksLikeTitle,
	titleRequest,
	titleWithOneRetry,
} from "./title";
import type { Message } from "$lib/chat/types/Message";

// Minimal message factory — only the fields the selector reads.
function msg(id: string, from: "user" | "assistant", extra: Partial<Message> = {}): Message {
	return { id, from, content: `${from}:${id}`, ...extra } as unknown as Message;
}
const flagged = {
	moderation: { flagged: true, label: "toxic", score: 0.99, kind: "toxicity" },
} as Partial<Message>;

describe("firstAnsweredUserMessage", () => {
	it("picks the first user message when nothing is moderated", () => {
		const messages = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user")];
		expect(firstAnsweredUserMessage(messages)?.id).toBe("u1");
	});

	it("skips a declined opening turn (adjacent assistant flagged) and titles from the next clean turn", () => {
		const messages = [
			msg("u1", "user"), // toxic
			msg("a1", "assistant", flagged), // decline
			msg("u2", "user"), // clean
			msg("a2", "assistant"), // real answer
		];
		expect(firstAnsweredUserMessage(messages)?.id).toBe("u2");
	});

	it("returns undefined when every turn so far was declined (keeps 'New Chat')", () => {
		const messages = [
			msg("u1", "user"),
			msg("a1", "assistant", flagged),
			msg("u2", "user"),
			msg("a2", "assistant", flagged),
		];
		expect(firstAnsweredUserMessage(messages)).toBeUndefined();
	});

	it("does not over-skip: a clean opening turn is kept even if a LATER turn is declined", () => {
		const messages = [
			msg("u1", "user"), // clean opening
			msg("a1", "assistant"), // real answer
			msg("u2", "user"), // later toxic
			msg("a2", "assistant", flagged), // decline
		];
		expect(firstAnsweredUserMessage(messages)?.id).toBe("u1");
	});

	it("returns undefined for an empty / assistant-only message list", () => {
		expect(firstAnsweredUserMessage([])).toBeUndefined();
		expect(firstAnsweredUserMessage([msg("a1", "assistant")])).toBeUndefined();
	});
});

describe("looksLikeTitle", () => {
	it("accepts a short noun-phrase title", () => {
		expect(looksLikeTitle("Python string reversal")).toBe(true);
		expect(looksLikeTitle("NYC weekend plan")).toBe(true);
	});

	it("accepts a short CJK title with no spaces", () => {
		expect(looksLikeTitle("Transformer 工作原理")).toBe(true);
	});

	it("rejects an empty or whitespace-only response", () => {
		expect(looksLikeTitle("")).toBe(false);
		expect(looksLikeTitle("   ")).toBe(false);
	});

	// On an agent-mode identity question ("what model are you and who made you?") the title
	// call can ignore the instruction and return a full persona reply like this one. (CUR-593)
	it("rejects a fabricated persona answer instead of a title", () => {
		expect(
			looksLikeTitle(
				"I'm glad you're curious! I'm an AI assistant created to help you find library resources, local services, and more."
			)
		).toBe(false);
	});

	// Live on preview, normal chat, unrelated to agent routing entirely. (CUR-593)
	it("rejects a fabricated normal-chat answer instead of a title", () => {
		expect(
			looksLikeTitle(
				"ALpha is awesome. I appreciate you bringing this up. For accurate information, I recommend consulting recent reports from credible sources."
			)
		).toBe(false);
	});

	it("rejects a long single-sentence run with no punctuation (space-sparse script safety net)", () => {
		expect(looksLikeTitle("あ".repeat(90))).toBe(false);
	});

	it("accepts exactly at the word/char boundary, rejects one past it", () => {
		const eightWords = "one two three four five six seven eight";
		expect(looksLikeTitle(eightWords)).toBe(true);
		expect(looksLikeTitle(`${eightWords} nine`)).toBe(false);
	});

	// Four real outputs of the title call ignoring the instruction and returning a full answer
	// instead (CUR-542), kept verbatim rather than paraphrased, so a future change to the
	// char/word thresholds is checked against the failures this guard exists to catch, not just
	// the narrower examples above.
	describe("CUR-542 repros — all four predate this guard, all four must stay rejected", () => {
		it("rejects the false 'I can't create files' claim on a turn that created one", () => {
			expect(
				looksLikeTitle(
					"I appreciate your request! However, I'm unable to create files or interact with your computer directly."
				)
			).toBe(false);
		});

		it("rejects the off-task script-writing chatter", () => {
			expect(
				looksLikeTitle(
					"POTLUCK is awesome I'd be happy to help you create a script for analyzing your CSV data! Here"
				)
			).toBe(false);
		});

		it("rejects a rewritten letter body standing in for a title", () => {
			expect(
				looksLikeTitle(
					"Dear [Recipient's Name], I am writing to formally request a review of the recent decision regarding my application."
				)
			).toBe(false);
		});

		it("rejects the fabricated library-catalog / events-calendar capability list", () => {
			expect(
				looksLikeTitle(
					"I can access specialized tools like the local events calendar, the library's catalog search, the summer reading program tracker, and"
				)
			).toBe(false);
		});
	});
});

/**
 * Named for the contract, not the behaviour (a test's name states the contract). The defect this covers is four
 * distinct outcomes handing back one indistinguishable string, so every test here asserts that the
 * SOURCE separates them — the title text on its own is allowed to be identical and usually is.
 *
 * An assertion that "the title is not the first five words" fails the same way for a
 * deployment with titling off, for a reply that fails `looksLikeTitle`, for a thrown call, and for
 * a slow one, printing the same message every time. (CUR-1819)
 */
const PROMPT = "CUR-1686 F2 scenario: what is the capital of France";

describe("classifyTitle", () => {
	it("says model only when the reply is title-shaped, which is the one claim worth asserting", () => {
		expect(classifyTitle(PROMPT, "French capital")).toEqual({
			title: "French capital",
			source: "model",
		});
	});

	it("does not report an off-task reply as a generation failure, because the product meant to do that", () => {
		// CUR-593's case: the model answered the question instead of naming it. The fallback is
		// correct behaviour, so the source names the shape of the reply rather than an error.
		const answered =
			"The capital of France is Paris, which has been the seat of government since 987.";
		expect(classifyTitle(PROMPT, answered)).toEqual({
			title: firstFiveWords(PROMPT),
			source: "reply-not-title-shaped",
		});
	});

	it("never shows a provider's leaked reasoning as the title", () => {
		// A provider can answer a reasoning-off GLM call with its reasoning as plain
		// content, cut off by the 24-token budget. This is such a reply. (CUR-2090)
		const leaked =
			'The user is asking me to title a chat thread. The first (and only) user message is "How do I';
		expect(classifyTitle(PROMPT, leaked)).toEqual({
			title: firstFiveWords(PROMPT),
			source: "reply-not-title-shaped",
		});
	});

	it("reports a thrown call as generation-failed rather than as an off-task reply", () => {
		expect(classifyTitle(PROMPT, null)).toEqual({
			title: firstFiveWords(PROMPT),
			source: "generation-failed",
		});
		expect(classifyTitle(PROMPT, undefined)).toEqual({
			title: firstFiveWords(PROMPT),
			source: "generation-failed",
		});
	});

	it("reports an empty reply as not-title-shaped, not as a failure — the call did return", () => {
		expect(classifyTitle(PROMPT, "   ")).toEqual({
			title: firstFiveWords(PROMPT),
			source: "reply-not-title-shaped",
		});
	});

	it("gives the same title text down three of the four paths, which is why the source exists", () => {
		const fallback = firstFiveWords(PROMPT);
		const paths = [
			classifyTitle(PROMPT, null),
			classifyTitle(PROMPT, ""),
			classifyTitle(PROMPT, "A sentence long enough that it cannot be a title at all, plainly."),
		];
		expect(paths.map((p) => p.title)).toEqual([fallback, fallback, fallback]);
		expect(new Set(paths.map((p) => p.source)).size).toBe(2);
	});

	it("trims the model's reply rather than showing its whitespace", () => {
		expect(classifyTitle(PROMPT, "  French capital  ").title).toBe("French capital");
	});

	it("takes five words, not five tokens, and collapses runs of whitespace", () => {
		expect(firstFiveWords("one  two\tthree\nfour five six seven")).toBe("one two three four five");
	});
});

// `null` is a failed side-call (ceiling or upstream error); a string is the model's reply. (CUR-2046)
describe("titleWithOneRetry", () => {
	const scripted = (...results: (string | null)[]) => {
		const attempt = vi.fn(async () => results.shift() ?? null);
		return attempt;
	};

	it("retries a failed call once and keeps the model's title from the second attempt", async () => {
		const attempt = scripted(null, "Project budget");
		const generated = await titleWithOneRetry(attempt);
		expect(attempt).toHaveBeenCalledTimes(2);
		expect(classifyTitle("A project needs 3 people", generated)).toEqual({ title: "Project budget", source: "model" });
	});

	it("still reports generation-failed when both attempts fail — the retry does not hide a real outage", async () => {
		const attempt = scripted(null, null);
		const generated = await titleWithOneRetry(attempt);
		expect(attempt).toHaveBeenCalledTimes(2);
		expect(classifyTitle("A project needs 3 people", generated).source).toBe("generation-failed");
	});

	it("never retries a reply, even one classifyTitle rejects: that is the model answering", async () => {
		const attempt = scripted("Sure! Here is a long answer. It has two sentences.");
		await titleWithOneRetry(attempt);
		expect(attempt).toHaveBeenCalledTimes(1);
	});
});

describe("titleRequest", () => {
	it("sends Apertus one user message with no system role, since its pooled deployments refuse one (CUR-2175)", () => {
		const { messages, preprompt } = titleRequest("How do I reverse a string?", "swiss-ai/apertus-v1.5-70b");
		expect(preprompt, "a preprompt becomes a system message on the wire").toBeUndefined();
		expect(messages).toHaveLength(1);
		expect(messages[0].from).toBe("user");
		expect(messages[0].content).toContain("You are a chat thread titling assistant.");
		expect(messages[0].content).toContain('User message: "How do I reverse a string?"');
	});

	it("keeps the system preprompt for a model that serves roles", () => {
		const { messages, preprompt } = titleRequest("How do I reverse a string?", "test-model");
		expect(preprompt).toContain("You are a chat thread titling assistant.");
		expect(messages).toEqual([{ from: "user", content: 'User message: "How do I reverse a string?"' }]);
	});
});
