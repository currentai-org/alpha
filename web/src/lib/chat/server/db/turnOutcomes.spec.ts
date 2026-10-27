import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
const { logger } = (await import("$lib/chat/server/logger")) as unknown as {
	logger: { warn: ReturnType<typeof vi.fn> };
};

const insert = vi.fn();
vi.mock("./client", () => ({ getDb: () => ({ insert }) }));

import { recordTurnOutcome } from "./turnOutcomes";

// What this pins, stated as the contract rather than the behaviour: a failed turn-outcome write must
// be OBSERVABLE and must not reach the turn. Both halves matter and they pull opposite ways.
//
// The observability half is the less obvious one. runInBackground does `work.catch(() => {})`
// (vercelBackground.ts:34), so nothing downstream of a rejection here can see it. And the consumer —
// warmTurnOutcomeRate — is careful about the READ (it records nothing rather than a healthy zero when
// the count throws) but structurally cannot notice a broken WRITER: the read still succeeds, it just
// counts fewer rows, which looks exactly like quiet traffic. At low traffic against a 6h window
// and MIN_SAMPLE 15, partial write loss holds the probe under its floor forever, so it never evaluates
// and never alerts. Silence there is the failure, which is why the assertion is on the log call.

beforeEach(() => {
	insert.mockReset();
	logger.warn.mockReset();
});

describe("recordTurnOutcome() — a failed metrics write is loud but harmless", () => {
	it("logs a warning when the insert rejects (the rate probe cannot detect this itself)", async () => {
		insert.mockReturnValue({ values: () => Promise.reject(new Error("neon: too many connections")) });
		await recordTurnOutcome("error", null);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		const [fields, msg] = logger.warn.mock.calls[0];
		expect(msg).toMatch(/write failed/i);
		expect(fields.err).toMatch(/too many connections/);
		expect(fields.outcome).toBe("error");
	});

	it("does NOT reject — a metrics write must never affect a turn that already answered", async () => {
		insert.mockReturnValue({ values: () => Promise.reject(new Error("boom")) });
		await expect(recordTurnOutcome("timedOut", null)).resolves.toBeUndefined();
	});

	it("stays silent on the happy path, so the warning means something when it appears", async () => {
		insert.mockReturnValue({ values: () => Promise.resolve() });
		await recordTurnOutcome("complete", null);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("passes the outcome and declineKind through to the row", async () => {
		const values = vi.fn().mockResolvedValue(undefined);
		insert.mockReturnValue({ values });
		await recordTurnOutcome("declined", "child_safety");
		expect(values).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "declined", declineKind: "child_safety" })
		);
	});
});
