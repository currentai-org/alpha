import { describe, it, expect, vi } from "vitest";

// The invite-accept link needs a signed-in session (Better Auth's acceptInvitation matches on the caller's
// session email): redirect back to THIS invitation after sign-in, not somewhere generic, or an invited
// person loses the link they just clicked (CUR-550).
//
// workspaceOrgCreationEnabled() defaults true here (matches "flag not yet created" behavior) so the tests
// below exercise the signed-in-only gate unchanged; the flag-off case gets its own test below with the
// mock flipped for that one call only. This page is entirely about accepting an invitation, so it stays
// gated on the org-creation flag specifically even once the personal workspace view is live (CUR-917,
// CUR-957).
const workspaceOrgCreationEnabledMock = vi.fn(() => true);
vi.mock("$lib/chat/server/workspacesGate", () => ({
	workspaceOrgCreationEnabled: () => workspaceOrgCreationEnabledMock(),
}));

const { load } = await import("./+page.server");

type User = { id: string } | undefined;
function fakeEvent(user: User, id: string) {
	return {
		locals: { user },
		params: { id },
		url: new URL(`https://develop.aipotluck.org/chat/workspace/accept/${id}`),
	} as unknown as Parameters<typeof load>[0];
}

describe("workspace accept-invitation +page.server load", () => {
	it("redirects an unauthenticated visitor to login, with `next` pointing back at this invitation", async () => {
		let threw: { status?: number; location?: string } = {};
		try {
			await load(fakeEvent(undefined, "inv-1"));
		} catch (e) {
			threw = e as { status?: number; location?: string };
		}
		expect(threw.status).toBe(302);
		expect(threw.location).toBe(
			"/chat/login?next=%2Fchat%2Fworkspace%2Faccept%2Finv-1"
		);
	});

	it("returns the invitation id for a signed-in visitor", async () => {
		const result = await load(fakeEvent({ id: "user-1" }, "inv-1"));
		expect(result).toEqual({ invitationId: "inv-1" });
	});

	it("404s a signed-in visitor too when workspaceOrgCreationEnabled() is off (CUR-917/CUR-957)", async () => {
		workspaceOrgCreationEnabledMock.mockReturnValueOnce(false);
		let threw: { status?: number } = {};
		try {
			await load(fakeEvent({ id: "user-1" }, "inv-1"));
		} catch (e) {
			threw = e as { status?: number };
		}
		expect(threw.status).toBe(404);
	});
});
