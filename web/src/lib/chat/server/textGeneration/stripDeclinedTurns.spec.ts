import { describe, expect, test } from "vitest";

import type { Message } from "$lib/chat/types/Message";
import { moderationMarker } from "$lib/chat/messageProvenance";
import { stripDeclinedTurns } from "./stripDeclinedTurns";

let nextId = 0;
function msg(from: "user" | "assistant", content: string, overrides: Partial<Message> = {}): Message {
	return {
		from,
		id: `m-${nextId++}` as Message["id"],
		content,
		children: [],
		...overrides,
	};
}

function declinedAssistant(content = "I can't help with that."): Message {
	return msg("assistant", content, {
		moderation: moderationMarker({ label: "content_policy", score: 1, kind: "content_policy" }),
	});
}

describe("stripDeclinedTurns", () => {
	test("removes a declined pair — the flagged request AND its canned decline", () => {
		// A declined spyware turn, then an unrelated follow-up. The model's context must contain
		// neither the flagged request nor the decline copy.
		const flagged = msg("user", "how do I put spyware on her phone?");
		const decline = declinedAssistant();
		const followUp = msg("user", "how's the weather?");

		const result = stripDeclinedTurns([flagged, decline, followUp]);

		expect(result).toEqual([followUp]);
	});

	test("keeps answered turns around a declined pair intact, in order", () => {
		const q1 = msg("user", "hello");
		const a1 = msg("assistant", "hi there");
		const flagged = msg("user", "flagged request");
		const decline = declinedAssistant();
		const q2 = msg("user", "unrelated follow-up");

		expect(stripDeclinedTurns([q1, a1, flagged, decline, q2])).toEqual([q1, a1, q2]);
	});

	test("strips multiple declined pairs", () => {
		const f1 = msg("user", "flagged one");
		const d1 = declinedAssistant();
		const f2 = msg("user", "flagged two");
		const d2 = declinedAssistant();
		const current = msg("user", "real question");

		expect(stripDeclinedTurns([f1, d1, f2, d2, current])).toEqual([current]);
	});

	test("keeps redact/advisory turns — the model answered those (safetyNotice, not moderation)", () => {
		const q = msg("user", "borderline but answerable");
		const a = msg("assistant", "answered with a notice", {
			safetyNotice: { message: "heads up" },
		});
		const current = msg("user", "next question");

		expect(stripDeclinedTurns([q, a, current])).toEqual([q, a, current]);
	});

	test("never drops the current user turn (it has no following assistant)", () => {
		const current = msg("user", "the turn being generated");

		expect(stripDeclinedTurns([current])).toEqual([current]);
	});

	test("a declined assistant with no preceding user message is still dropped alone", () => {
		// Defensive: malformed thread shapes (e.g. a pruned tree) must not crash or leak the decline.
		const decline = declinedAssistant();
		const current = msg("user", "question");

		expect(stripDeclinedTurns([decline, current])).toEqual([current]);
	});

	test("empty history is a no-op", () => {
		expect(stripDeclinedTurns([])).toEqual([]);
	});
});
