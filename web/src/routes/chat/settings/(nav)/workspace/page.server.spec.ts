import { describe, it, expect, vi } from "vitest";

// Same signed-in-only enforcement as ../account/page.server.spec.ts: the org calls this page makes all
// need a real Better Auth session, so a signed-out visitor must never reach it (CUR-550).
//
// workspacesEnabled() defaults true here (matches "flag not yet created" behavior) so the tests below
// exercise the signed-in-only gate unchanged; the flag-off case gets its own test below with the mock
// flipped for that one call only (CUR-913).
const workspacesEnabledMock = vi.fn(() => true);
// workspaceOrgCreationEnabled() must actually reach page.data (see the load() comment). Defaults false,
// matching that gate's own fail-closed fallback.
const workspaceOrgCreationEnabledMock = vi.fn(() => false);
vi.mock("$lib/chat/server/workspacesGate", () => ({
	workspacesEnabled: () => workspacesEnabledMock(),
	workspaceOrgCreationEnabled: () => workspaceOrgCreationEnabledMock(),
}));
// The former-workspace list comes from the same scope read the chat list uses. (CUR-3040)
const workspaceScopeForMock = vi.fn(async (): Promise<unknown> => null);
vi.mock("$lib/chat/server/currentWorkspace", () => ({
	workspaceScopeFor: () => workspaceScopeForMock(),
}));

const { load } = await import("./+page.server");

type User = { id: string } | undefined;
const setHeaders = vi.fn();
function fakeEvent(user: User) {
	return {
		locals: { user },
		setHeaders,
		url: new URL("https://develop.aipotluck.org/chat/settings/workspace"),
	} as unknown as Parameters<typeof load>[0];
}

// The page now renders on the server, and that HTML carries the visitor's session. (CUR-1975)
describe("workspace +page.server load — server-rendered, never shared-cached", () => {
	it("marks a signed-in render private and uncacheable, since it carries that visitor's session", async () => {
		setHeaders.mockReset();
		await load(fakeEvent({ id: "user-1" }));
		expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
	});
});

describe("workspace +page.server load — signed-in-only, enforced server-side", () => {
	it("redirects an unauthenticated visitor to login instead of rendering the page", async () => {
		let threw: { status?: number; location?: string } = {};
		try {
			await load(fakeEvent(undefined));
		} catch (e) {
			threw = e as { status?: number; location?: string };
		}
		expect(threw.status).toBe(302);
		expect(threw.location).toBe("/chat/login?next=%2Fchat%2Fsettings%2Fworkspace");
	});

	it("does not throw for a signed-in visitor", async () => {
		await expect(load(fakeEvent({ id: "user-1" }))).resolves.toBeDefined();
	});

	// Without this field in page data, +page.svelte's loadOrganizations()/resolveOrganizationsState()
	// always treat org creation as off, hiding a real workspace member's own org list/switcher/admin
	// tools, not just the create/invite UI. This is the contract that guards it.
	it("passes the live workspaceOrgCreationEnabled() value through to page data — OFF case", async () => {
		workspaceOrgCreationEnabledMock.mockReturnValueOnce(false);
		await expect(load(fakeEvent({ id: "user-1" }))).resolves.toEqual({
			workspaceOrgCreationEnabled: false,
			formerWorkspaces: [],
			viewingFormerId: null,
		});
	});

	it("passes the live workspaceOrgCreationEnabled() value through to page data — ON case", async () => {
		workspaceOrgCreationEnabledMock.mockReturnValueOnce(true);
		await expect(load(fakeEvent({ id: "user-1" }))).resolves.toEqual({
			workspaceOrgCreationEnabled: true,
			formerWorkspaces: [],
			viewingFormerId: null,
		});
	});

	it("404s a signed-in visitor too when workspacesEnabled() is off (CUR-913)", async () => {
		workspacesEnabledMock.mockReturnValueOnce(false);
		let threw: { status?: number } = {};
		try {
			await load(fakeEvent({ id: "user-1" }));
		} catch (e) {
			threw = e as { status?: number };
		}
		expect(threw.status).toBe(404);
	});

	it("passes the former workspaces and the one being viewed through to page data (CUR-3040)", async () => {
		const gone = { id: "org-gone", name: "Food bank", kind: "deleted" };
		workspaceScopeForMock.mockResolvedValueOnce({
			current: null,
			memberOrgIds: [],
			workspaces: [],
			former: [gone],
			viewingFormer: gone,
		});
		await expect(load(fakeEvent({ id: "user-1" }))).resolves.toMatchObject({
			formerWorkspaces: [gone],
			viewingFormerId: "org-gone",
		});
	});
});
