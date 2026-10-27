/**
 * otpSourceSendAllowed/recordOtpSourceSend are keyed on the (ip, target-email)
 * PAIR, not on the IP alone — the whole point is that a shared conference/demo IP with many distinct
 * real attendees never approaches the cap, while one source repeatedly hitting the SAME victim does.
 * These tests exercise that property directly against the actual query filter, not just the wiring —
 * asserting only that the fields are "truthy" would pass a bug that hashed BOTH
 * `ipHash` and `userId` from the same input (email or ip). (CUR-920)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { insertOne, countDocuments } = vi.hoisted(() => ({
	insertOne: vi.fn(),
	countDocuments: vi.fn(),
}));

vi.mock("$lib/chat/server/database", () => ({
	collections: { messageEvents: { insertOne, countDocuments } },
}));
vi.mock("$lib/chat/server/config", () => ({
	config: { CONTRIBUTION_IP_PEPPER: "test-pepper-0123456789abcdef" },
}));
vi.mock("$lib/chat/server/logger.js", () => ({ logger: { warn: vi.fn() } }));

import { otpSourceSendAllowed, recordOtpSourceSend, OTP_SOURCE_MAX } from "./targetEmailRate";
import { OTP_RATE_MAX } from "$lib/chat/server/betterAuth";

beforeEach(() => {
	insertOne.mockReset().mockResolvedValue(undefined);
	countDocuments.mockReset().mockResolvedValue(0);
});

describe("otpSourceSendAllowed / recordOtpSourceSend", () => {
	it("queries by BOTH the ip hash and the target-email hash, and the two are genuinely different values", async () => {
		await otpSourceSendAllowed("203.0.113.7", "victim@example.com");
		expect(countDocuments).toHaveBeenCalledTimes(1);
		const filter = countDocuments.mock.calls[0][0];
		expect(filter.ipHash).toBeTruthy();
		expect(filter.userId).toBeTruthy(); // the target-email hash, stored in userId (see file header)
		// Not just "both truthy" — a copy-paste bug that hashed the SAME input into both fields (or
		// hashed both with the same domain) would pass a truthy-only check but degrade the pair cap
		// toward a flat per-IP or per-target count. They must differ.
		expect(filter.ipHash).not.toBe(filter.userId);
		expect(filter.type).toBe("otpSourceRate");
	});

	it("denies once the SAME (ip, target) pair hits the cap", async () => {
		countDocuments.mockResolvedValue(OTP_SOURCE_MAX);
		await expect(otpSourceSendAllowed("203.0.113.7", "victim@example.com")).resolves.toBe(false);
	});

	it("the SAME ip against DIFFERENT targets produces the SAME ipHash but a DIFFERENT userId — a shared conference IP with distinct attendees never inflates one pair's count", async () => {
		await otpSourceSendAllowed("203.0.113.7", "attendee-42@example.com");
		const filterA = countDocuments.mock.calls[0][0];
		await otpSourceSendAllowed("203.0.113.7", "attendee-99@example.com");
		const filterB = countDocuments.mock.calls[1][0];

		expect(filterB.ipHash).toBe(filterA.ipHash); // same source IP
		expect(filterB.userId).not.toBe(filterA.userId); // different target → independent pair
	});

	it("DIFFERENT ips against the SAME target produce the SAME userId but a DIFFERENT ipHash — this is the axis an attacker rotating IPs would need to defeat the cap on", async () => {
		await otpSourceSendAllowed("203.0.113.7", "victim@example.com");
		const filterA = countDocuments.mock.calls[0][0];
		await otpSourceSendAllowed("198.51.100.9", "victim@example.com");
		const filterB = countDocuments.mock.calls[1][0];

		expect(filterB.userId).toBe(filterA.userId); // same target
		expect(filterB.ipHash).not.toBe(filterA.ipHash); // different source IP → independent pair
	});

	it("fails open when no pepper is configured — can't pseudonymize, can't track", async () => {
		vi.doMock("$lib/chat/server/config", () => ({ config: {} }));
		vi.resetModules();
		const { otpSourceSendAllowed: allowedNoPepper } = await import("./targetEmailRate");
		await expect(allowedNoPepper("203.0.113.7", "victim@example.com")).resolves.toBe(true);
		expect(countDocuments).not.toHaveBeenCalled();
	});

	it("fails open on a DB error", async () => {
		countDocuments.mockRejectedValue(new Error("db down"));
		await expect(otpSourceSendAllowed("203.0.113.7", "victim@example.com")).resolves.toBe(true);
	});

	it("recordOtpSourceSend inserts a row keyed the same way, and is a no-op on DB error", async () => {
		await recordOtpSourceSend("203.0.113.7", "victim@example.com", 600_000);
		expect(insertOne).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "otpSourceRate",
				ipHash: expect.any(String),
				userId: expect.any(String),
			})
		);
		const inserted = insertOne.mock.calls[0][0];
		expect(inserted.ipHash).not.toBe(inserted.userId);

		insertOne.mockRejectedValueOnce(new Error("db down"));
		await expect(
			recordOtpSourceSend("203.0.113.7", "victim@example.com", 600_000)
		).resolves.toBeUndefined();
	});

	it("OTP_SOURCE_MAX stays strictly below OTP_RATE_MAX — otherwise one source alone could exhaust a victim's whole target-wide budget, defeating the reason this cap exists", () => {
		expect(OTP_SOURCE_MAX).toBeLessThan(OTP_RATE_MAX);
	});
});
