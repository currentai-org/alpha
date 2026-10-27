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

import { agentTaskRoom, agentTasksPerDay, recordAgentTask, agentTasksUsedText } from "./agentTaskAllowance";

// The limit the ticket promises: 25 tasks per account in any 24 hours.
const PER_DAY = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
const account = { user: { _id: "user-1" }, sessionId: "sess-1" } as unknown as App.Locals;

beforeEach(() => {
	insertOne.mockReset().mockResolvedValue(undefined);
	countDocuments.mockReset();
	find.mockReset();
});

describe("agentTaskRoom (CUR-4401)", () => {
	it("allows the 25th task of the day, keyed on the account rather than the session", async () => {
		countDocuments.mockResolvedValue(PER_DAY - 1);
		await expect(agentTaskRoom(account)).resolves.toEqual({ ok: true });
		expect(countDocuments).toHaveBeenCalledWith(expect.objectContaining({ type: "agentTask", userId: "user-1" }));
	});

	it("refuses the 26th and says when the oldest counted task stops counting", async () => {
		countDocuments.mockResolvedValue(PER_DAY);
		const now = Date.now();
		const expiries = Array.from({ length: PER_DAY }, (_, i) => ({ expiresAt: new Date(now + (i + 1) * 3_600_000) }));
		find.mockReturnValue({ toArray: async () => expiries });
		const room = await agentTaskRoom(account);
		expect(room.ok).toBe(false);
		expect(room.ok === false && room.retryAfterSecs).toBeGreaterThan(3500);
		expect(room.ok === false && room.retryAfterSecs).toBeLessThanOrEqual(3600);
	});

	it("fails open when the count cannot be read, since agent-service's own caps still bound the run", async () => {
		countDocuments.mockRejectedValue(new Error("db down"));
		await expect(agentTaskRoom(account)).resolves.toEqual({ ok: true });
	});

	it("counts a guest that got this far by session id rather than letting it through uncounted", async () => {
		countDocuments.mockResolvedValue(PER_DAY);
		find.mockReturnValue({ toArray: async () => [] });
		const guest = { sessionId: "sess-9" } as unknown as App.Locals;
		await expect(agentTaskRoom(guest)).resolves.toMatchObject({ ok: false });
		expect(countDocuments).toHaveBeenCalledWith(expect.objectContaining({ userId: "sess-9" }));
	});
});

describe("the staff tier on agent tasks (CUR-4620)", () => {
	const team = { user: { _id: "user-t", email: "someone@currentai.org", emailVerified: true }, sessionId: "sess-t" } as unknown as App.Locals;
	const stranger = { user: { _id: "user-s", email: "stranger@example.com", emailVerified: true }, sessionId: "sess-s" } as unknown as App.Locals;
	const unverified = { user: { _id: "user-u", email: "someone@currentai.org", emailVerified: false }, sessionId: "sess-u" } as unknown as App.Locals;

	it("a currentai.org account is not stopped at the 25th agent task", async () => {
		countDocuments.mockResolvedValue(PER_DAY);
		await expect(agentTaskRoom(team)).resolves.toEqual({ ok: true });
		expect(agentTasksPerDay(team)).toBe(1000);
	});

	it("a team account is still stopped at the staff tier's 1,000, so a runaway loop ends", async () => {
		countDocuments.mockResolvedValue(1000);
		find.mockReturnValue({ toArray: async () => [] });
		await expect(agentTaskRoom(team)).resolves.toMatchObject({ ok: false, limit: 1000 });
	});

	it("a non-team account is still stopped at its 26th task", async () => {
		countDocuments.mockResolvedValue(PER_DAY);
		find.mockReturnValue({ toArray: async () => [] });
		await expect(agentTaskRoom(stranger)).resolves.toMatchObject({ ok: false, limit: PER_DAY });
	});

	it("an unverified team address gets no staff tier, so a typed-in address cannot claim it", async () => {
		countDocuments.mockResolvedValue(PER_DAY);
		find.mockReturnValue({ toArray: async () => [] });
		await expect(agentTaskRoom(unverified)).resolves.toMatchObject({ ok: false, limit: PER_DAY });
	});

	it("names the account's own limit when refusing", () => {
		expect(agentTasksUsedText(null, 1000)).toBe("You've used today's 1,000 agent tasks. More open up within 24 hours.");
	});
});

describe("recordAgentTask (CUR-4401)", () => {
	it("writes one row that stops counting after 24 hours", async () => {
		const before = Date.now();
		await recordAgentTask(account);
		expect(insertOne).toHaveBeenCalledTimes(1);
		const row = insertOne.mock.calls[0][0];
		expect(row).toMatchObject({ type: "agentTask", userId: "user-1" });
		expect(row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(DAY_MS);
		expect(row.expiresAt.getTime() - before).toBeLessThan(DAY_MS + 5_000);
	});

	it("never throws when the write fails", async () => {
		insertOne.mockRejectedValue(new Error("db down"));
		await expect(recordAgentTask(account)).resolves.toBeUndefined();
	});
});

describe("agentTasksUsedText", () => {
	it("names minutes under an hour, hours above, and stays honest without a time", () => {
		expect(agentTasksUsedText(30)).toBe("You've used today's 25 agent tasks. The next one opens up in 1 minute.");
		expect(agentTasksUsedText(3600 * 5)).toBe("You've used today's 25 agent tasks. The next one opens up in about 5 hours.");
		expect(agentTasksUsedText(null)).toBe("You've used today's 25 agent tasks. More open up within 24 hours.");
	});
});
