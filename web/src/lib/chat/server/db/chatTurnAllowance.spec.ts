import { describe, it, expect, vi, beforeEach } from "vitest";

const { insertOne, countDocuments, find } = vi.hoisted(() => ({
	insertOne: vi.fn(),
	countDocuments: vi.fn(),
	find: vi.fn(),
}));
vi.mock("$lib/chat/server/database", () => ({
	collections: { messageEvents: { insertOne, countDocuments, find } },
}));
vi.mock("$lib/chat/server/logger.js", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { chatTurnRoom, chatTurnsPerDay, chatTurnsUsedText } from "./chatTurnAllowance";
import { CHAT_TURNS_PER_DAY } from "../../../../../config/chatTurns";
import { STAFF_TIER } from "$lib/chat/server/teamAccount";

beforeEach(() => {
	insertOne.mockReset().mockResolvedValue(undefined);
	countDocuments.mockReset();
	find.mockReset();
});

describe("chatTurnsPerDay", () => {
	it("gives a visitor the committed number and a verified team account the staff tier's", () => {
		expect(chatTurnsPerDay(undefined)).toBe(CHAT_TURNS_PER_DAY);
		const visitor = { email: "someone@example.com", emailVerified: true } as App.Locals["user"];
		expect(chatTurnsPerDay(visitor)).toBe(CHAT_TURNS_PER_DAY);
		const team = { email: "someone@currentai.org", emailVerified: true } as App.Locals["user"];
		expect(chatTurnsPerDay(team)).toBe(STAFF_TIER.chatTurnsPerDay);
	});

	it("keeps the staff tier above a visitor's, so a team account is never stopped first", () => {
		expect(STAFF_TIER.chatTurnsPerDay).toBeGreaterThan(CHAT_TURNS_PER_DAY);
	});
});

describe("chatTurnRoom", () => {
	it("allows the last turn of the day, counting the owner's chatTurn rows", async () => {
		countDocuments.mockResolvedValue(1);
		await expect(chatTurnRoom("user-1", 2)).resolves.toEqual({ ok: true });
		expect(countDocuments).toHaveBeenCalledWith(expect.objectContaining({ type: "chatTurn", userId: "user-1" }));
	});

	it("refuses at the limit and says when the oldest counted turn stops counting", async () => {
		countDocuments.mockResolvedValue(2);
		const now = Date.now();
		find.mockReturnValue({
			toArray: async () => [
				{ expiresAt: new Date(now + 2 * 3_600_000) },
				{ expiresAt: new Date(now + 5 * 3_600_000) },
			],
		});
		const room = await chatTurnRoom("user-1", 2);
		expect(room.ok).toBe(false);
		expect(room.ok === false && room.retryAfterSecs).toBeGreaterThan(7100);
		expect(room.ok === false && room.retryAfterSecs).toBeLessThanOrEqual(7200);
	});

	it("fails open when the count cannot be read", async () => {
		countDocuments.mockRejectedValue(new Error("db down"));
		await expect(chatTurnRoom("user-1", 2)).resolves.toEqual({ ok: true });
	});
});

describe("chatTurnsUsedText", () => {
	it("names the limit and the wait in hours", () => {
		expect(chatTurnsUsedText(200, 3 * 3600)).toBe(
			"You've reached today's message limit of 200 messages. The next one opens up in about 3 hours."
		);
	});

	it("says within 24 hours when the wait could not be read", () => {
		expect(chatTurnsUsedText(200, null)).toMatch(/More open up within 24 hours\.$/);
	});
});
