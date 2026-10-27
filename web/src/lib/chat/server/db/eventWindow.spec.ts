import { describe, it, expect, vi, beforeEach } from "vitest";

const { insertOne, countDocuments, deleteMany, find, warn } = vi.hoisted(() => ({
	insertOne: vi.fn(),
	find: vi.fn(),
	countDocuments: vi.fn(),
	deleteMany: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("$lib/chat/server/database", () => ({
	collections: { messageEvents: { insertOne, countDocuments, deleteMany, find } },
}));
vi.mock("$lib/chat/server/logger.js", () => ({ logger: { warn } }));

import { clearEvents, countLiveEvents, recordEvent, secondsUntilRoom, underEventLimit } from "./eventWindow";

beforeEach(() => {
	vi.useRealTimers();
	insertOne.mockReset().mockResolvedValue(undefined);
	countDocuments.mockReset().mockResolvedValue(0);
	deleteMany.mockReset().mockResolvedValue(undefined);
	find.mockReset().mockReturnValue({ toArray: async () => [] });
	warn.mockReset();
});

describe("eventWindow", () => {
	it("counts only the key's unexpired rows, so each limit is a sliding window", async () => {
		vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00Z") });
		countDocuments.mockResolvedValue(3);
		await expect(countLiveEvents({ type: "t", ipHash: "h" }, "l")).resolves.toBe(3);
		expect(countDocuments).toHaveBeenCalledWith({
			type: "t",
			ipHash: "h",
			expiresAt: { $gt: new Date("2026-10-01T12:00:00Z") },
		});
	});

	it("allows below the limit and refuses at it", async () => {
		countDocuments.mockResolvedValue(4);
		await expect(underEventLimit({ type: "t", userId: "u" }, 5, "l")).resolves.toBe(true);
		countDocuments.mockResolvedValue(5);
		await expect(underEventLimit({ type: "t", userId: "u" }, 5, "l")).resolves.toBe(false);
	});

	it("fails open: a failed count reads as null, allows the request, and logs under the caller's label", async () => {
		countDocuments.mockRejectedValue(new Error("db down"));
		await expect(countLiveEvents({ type: "t" }, "admin-login")).resolves.toBeNull();
		await expect(underEventLimit({ type: "t" }, 1, "admin-login")).resolves.toBe(true);
		expect(warn.mock.calls[0][1]).toMatch(/^\[admin-login\] count failed/);
	});

	it("records a row that expires one window from now", async () => {
		vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00Z") });
		await recordEvent({ type: "t", ipHash: "h", userId: "u" }, 60_000, "l");
		expect(insertOne).toHaveBeenCalledWith({
			type: "t",
			ipHash: "h",
			userId: "u",
			createdAt: new Date("2026-10-01T12:00:00Z"),
			expiresAt: new Date("2026-10-01T12:01:00Z"),
		});
	});

	it("never throws from a failed write or clear, so bookkeeping can't take down a request", async () => {
		insertOne.mockRejectedValue(new Error("db down"));
		deleteMany.mockRejectedValue(new Error("db down"));
		await expect(recordEvent({ type: "t" }, 1, "l")).resolves.toBeUndefined();
		await expect(clearEvents({ type: "t", ipHash: "h" }, "l")).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(2);
	});

	describe("secondsUntilRoom (CUR-3216)", () => {
		const at = (iso: string) => ({ expiresAt: new Date(iso) });
		beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00Z") }));

		it("is 0 when one more event fits under the limit", async () => {
			find.mockReturnValue({ toArray: async () => [at("2026-10-01T12:00:20Z")] });
			await expect(secondsUntilRoom({ type: "t", userId: "u" }, 2, "l")).resolves.toBe(0);
		});

		it("waits for the row whose expiry brings the count under the limit, not the newest or the oldest", async () => {
			// Limit 2 with four live rows: a send fits once at most one is live, so the third to expire.
			find.mockReturnValue({
				toArray: async () => [
					at("2026-10-01T12:00:50Z"),
					at("2026-10-01T12:00:05Z"),
					at("2026-10-01T12:00:12.2Z"),
					at("2026-10-01T12:00:29.2Z"),
				],
			});
			await expect(secondsUntilRoom({ type: "t", userId: "u" }, 2, "l")).resolves.toBe(30);
			expect(find).toHaveBeenCalledWith({
				type: "t",
				userId: "u",
				expiresAt: { $gt: new Date("2026-10-01T12:00:00Z") },
			});
		});

		it("at a limit of one counts from the latest row, so a refused send's own row sets the wait", async () => {
			find.mockReturnValue({
				toArray: async () => [at("2026-10-01T12:00:10Z"), at("2026-10-01T12:00:30Z")],
			});
			await expect(secondsUntilRoom({ type: "t", userId: "u" }, 1, "l")).resolves.toBe(30);
		});

		it("fails open to null on a failed read and logs under the caller's label", async () => {
			find.mockReturnValue({ toArray: async () => Promise.reject(new Error("db down")) });
			await expect(secondsUntilRoom({ type: "t", userId: "u" }, 1, "rate-limit:session")).resolves.toBeNull();
			expect(warn).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining("[rate-limit:session]"));
		});
	});
});
