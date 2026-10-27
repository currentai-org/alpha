// The in-app invite list is a second route into someone's attention, so it shows an invite
// only to the verified address it was sent to, and only while it can still be accepted. The query is
// stubbed to hand back rows the database filter would have let through by mistake, so these tests
// pin the second filter in code that stands behind it. (CUR-4167)
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ rows: [] as unknown[], getDb: vi.fn() }));
vi.mock("$lib/chat/server/db/client", () => ({ getDb: H.getDb }));

import { pendingInvitationsFor } from "./pendingInvitations";

const later = new Date(Date.now() + 7 * 24 * 60 * 60_000);
const row = (over: Record<string, unknown> = {}) => ({
	id: "inv-1",
	email: "ada@example.org",
	status: "pending",
	expiresAt: later,
	workspaceName: "Field team",
	inviterEmail: "boss@example.org",
	...over,
});

beforeEach(() => {
	H.getDb.mockReset();
	const chain = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: async () => H.rows,
	};
	H.getDb.mockReturnValue(chain);
});

describe("pendingInvitationsFor", () => {
	it("lists a live pending invite to the person's own verified address, matched without case", async () => {
		H.rows = [row()];
		expect(await pendingInvitationsFor({ email: "Ada@Example.org", emailVerified: true })).toEqual([
			{ id: "inv-1", workspaceName: "Field team", inviterEmail: "boss@example.org" },
		]);
	});

	it("lists nothing to an unverified address, and never queries", async () => {
		H.rows = [row()];
		expect(await pendingInvitationsFor({ email: "ada@example.org", emailVerified: false })).toEqual([]);
		expect(H.getDb).not.toHaveBeenCalled();
	});

	it("lists nothing addressed to a different email", async () => {
		H.rows = [row()];
		expect(await pendingInvitationsFor({ email: "eve@example.org", emailVerified: true })).toEqual([]);
	});

	it("drops an invite past its end date, and one already accepted or declined", async () => {
		H.rows = [row({ expiresAt: new Date(Date.now() - 1000) }), row({ status: "accepted" }), row({ status: "rejected" })];
		expect(await pendingInvitationsFor({ email: "ada@example.org", emailVerified: true })).toEqual([]);
	});

	it("lists nothing when the read fails, rather than failing the page", async () => {
		H.getDb.mockImplementation(() => {
			throw new Error("db down");
		});
		expect(await pendingInvitationsFor({ email: "ada@example.org", emailVerified: true })).toEqual([]);
	});
});
