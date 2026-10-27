import { describe, it, expect, vi, beforeEach } from "vitest";

const { insertOne, find, warn, flagEnabledOr } = vi.hoisted(() => ({
	insertOne: vi.fn(),
	find: vi.fn(),
	warn: vi.fn(),
	flagEnabledOr: vi.fn(),
}));

vi.mock("$lib/chat/server/database", () => ({
	collections: { messageEvents: { insertOne, find } },
}));
vi.mock("$lib/chat/server/logger.js", () => ({ logger: { warn } }));
vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr }));

import {
	ATTACHMENT_ALLOWANCE_FLAG,
	attachmentAllowanceEnforced,
	attachmentAllowanceLeft,
	fitsAllowance,
	recordAttachments,
} from "./attachmentAllowance";
import { ATTACHMENT_ALLOWANCE } from "$lib/chat/constants/uploadLimits";

const rows = (r: { bytes?: number; expiresAt: Date }[]) => find.mockReturnValue({ toArray: async () => r });

beforeEach(() => {
	vi.useRealTimers();
	insertOne.mockReset().mockResolvedValue(undefined);
	find.mockReset();
	rows([]);
	warn.mockReset();
});

describe("attachmentAllowanceLeft (CUR-3235)", () => {
	it("subtracts every live row's file and bytes from the guest allowance, and resets when the oldest expires", async () => {
		vi.useFakeTimers({ now: new Date("2026-10-09T12:00:00Z") });
		rows([
			{ bytes: 1_000, expiresAt: new Date("2026-10-10T09:00:00Z") },
			{ bytes: 500, expiresAt: new Date("2026-10-10T03:00:00Z") },
		]);
		await expect(attachmentAllowanceLeft({ guestSessionId: "s" })).resolves.toEqual({
			files: ATTACHMENT_ALLOWANCE.guest.files - 2,
			bytes: ATTACHMENT_ALLOWANCE.guest.bytes - 1_500,
			resetsAt: new Date("2026-10-10T03:00:00Z"),
		});
		expect(find).toHaveBeenCalledWith({
			type: "chatAttachment",
			userId: "s",
			expiresAt: { $gt: new Date("2026-10-09T12:00:00Z") },
		});
	});

	it("gives a guest the network's room when the network's guests have spent more than this session could (CUR-3600)", async () => {
		const net = ATTACHMENT_ALLOWANCE.guestNetwork;
		find.mockImplementation((q: { ipHash?: string }) => ({
			toArray: async () =>
				q.ipHash
					? Array.from({ length: net.files - 2 }, () => ({ bytes: 1, expiresAt: new Date("2026-10-10T01:00:00Z") }))
					: [],
		}));
		const left = await attachmentAllowanceLeft({ guestSessionId: "s", ipHash: "net" });
		expect(left).toMatchObject({ files: 2, network: true, resetsAt: new Date("2026-10-10T01:00:00Z") });
		expect(find).toHaveBeenCalledWith(expect.objectContaining({ type: "chatAttachment", ipHash: "net" }));
	});

	it("holds a guest to the tighter of session and network on each dimension, so neither side's looser limit leaks through", async () => {
		const guest = ATTACHMENT_ALLOWANCE.guest;
		const net = ATTACHMENT_ALLOWANCE.guestNetwork;
		const MB = 1024 * 1024;
		// Session: 5 files and 1 MB left. Network: 3 files and plenty of bytes left.
		const sessionRows = Array.from({ length: guest.files - 5 }, (_, i) => ({
			bytes: i === 0 ? guest.bytes - MB : 0,
			expiresAt: new Date("2026-10-10T05:00:00Z"),
		}));
		const networkRows = Array.from({ length: net.files - 3 }, () => ({ bytes: 1, expiresAt: new Date("2026-10-10T01:00:00Z") }));
		find.mockImplementation((q: { ipHash?: string }) => ({ toArray: async () => (q.ipHash ? networkRows : sessionRows) }));
		const left = await attachmentAllowanceLeft({ guestSessionId: "s", ipHash: "net" });
		expect(left).toMatchObject({ files: 3, bytes: MB, network: true });
		expect(fitsAllowance(left, [3 * MB])).toBe(false);
		// Both sides bind, so the room frees only when the later of the two resets.
		expect(left?.resetsAt).toEqual(new Date("2026-10-10T05:00:00Z"));
	});

	it("gives a guest their session's room while the network has more left, and never counts an account by network", async () => {
		rows([{ bytes: 1, expiresAt: new Date() }]);
		const guest = await attachmentAllowanceLeft({ guestSessionId: "s", ipHash: "net" });
		expect(guest).toMatchObject({ files: ATTACHMENT_ALLOWANCE.guest.files - 1 });
		expect(guest?.network).toBeUndefined();
		find.mockClear();
		await attachmentAllowanceLeft({ userId: "u" });
		expect(find).toHaveBeenCalledTimes(1);
	});

	it("gives an account the account allowance", async () => {
		await expect(attachmentAllowanceLeft({ userId: "u" })).resolves.toEqual({
			files: ATTACHMENT_ALLOWANCE.account.files,
			bytes: ATTACHMENT_ALLOWANCE.account.bytes,
		});
	});

	it("never goes below zero", async () => {
		rows(Array.from({ length: ATTACHMENT_ALLOWANCE.guest.files + 3 }, () => ({ bytes: 10_000_000, expiresAt: new Date() })));
		const left = await attachmentAllowanceLeft({ guestSessionId: "s" });
		expect(left).toMatchObject({ files: 0, bytes: 0 });
	});

	it("fails open: a failed count reads as null, and null fits anything", async () => {
		find.mockReturnValue({ toArray: async () => Promise.reject(new Error("db down")) });
		const left = await attachmentAllowanceLeft({ userId: "u" });
		expect(left).toBeNull();
		expect(fitsAllowance(left, [10 ** 12])).toBe(true);
		expect(warn).toHaveBeenCalled();
	});
});

describe("fitsAllowance (CUR-3235)", () => {
	it("refuses a batch one file over what is left, and a batch one byte over", () => {
		expect(fitsAllowance({ files: 2, bytes: 100 }, [1, 1])).toBe(true);
		expect(fitsAllowance({ files: 2, bytes: 100 }, [1, 1, 1])).toBe(false);
		expect(fitsAllowance({ files: 2, bytes: 100 }, [50, 51])).toBe(false);
	});
});

describe("recordAttachments (CUR-3235)", () => {
	it("records one row per file with its size, expiring one day out", async () => {
		vi.useFakeTimers({ now: new Date("2026-10-09T12:00:00Z") });
		await recordAttachments({ guestSessionId: "s" }, [10, 20]);
		expect(insertOne.mock.calls.map((c) => c[0])).toEqual([
			{
				type: "chatAttachment",
				userId: "s",
				bytes: 10,
				createdAt: new Date("2026-10-09T12:00:00Z"),
				expiresAt: new Date("2026-10-10T12:00:00Z"),
			},
			{
				type: "chatAttachment",
				userId: "s",
				bytes: 20,
				createdAt: new Date("2026-10-09T12:00:00Z"),
				expiresAt: new Date("2026-10-10T12:00:00Z"),
			},
		]);
	});

	it("records a guest's network on each row, so the network count sees it (CUR-3600)", async () => {
		await recordAttachments({ guestSessionId: "s", ipHash: "net" }, [10]);
		expect(insertOne.mock.calls[0][0]).toMatchObject({ type: "chatAttachment", userId: "s", ipHash: "net" });
	});

	it("never throws when a write fails", async () => {
		insertOne.mockRejectedValue(new Error("db down"));
		await expect(recordAttachments({ userId: "u" }, [1])).resolves.toBeUndefined();
	});
});

describe("attachmentAllowanceEnforced (CUR-3600)", () => {
	it("refuses only when PostHog says so: a flag PostHog never answered leaves the allowance counting, not refusing", () => {
		flagEnabledOr.mockImplementation((_key: string, fallback: () => boolean) => fallback());
		expect(attachmentAllowanceEnforced()).toBe(false);
		flagEnabledOr.mockReturnValue(true);
		expect(attachmentAllowanceEnforced()).toBe(true);
		expect(flagEnabledOr).toHaveBeenCalledWith(ATTACHMENT_ALLOWANCE_FLAG, expect.any(Function));
	});
});
