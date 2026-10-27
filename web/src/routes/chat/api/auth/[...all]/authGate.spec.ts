import { describe, it, expect, vi, beforeEach } from "vitest";

// This route (CUR-434) is Better Auth's own catch-all — every sign-in/session/callback request for
// Google, GitHub, HF, passkey, and email-OTP flows through it. Sign-in has no flag of its own any more
// (CUR-1961); the one gate left here is the organization sub-path.
const getAuthHandler = vi.fn();
vi.mock("$lib/chat/server/betterAuth", () => ({
	getAuth: () => "auth-instance-marker",
}));
vi.mock("better-auth/svelte-kit", () => ({
	toSvelteKitHandler: () => getAuthHandler,
}));
// This route's org gate. Split to workspaceOrgCreationEnabled (CUR-957): this route is entirely about creating an
// additional workspace / inviting members, never just seeing your own, so it stays gated on the
// org-creation flag specifically, not the broader workspacesEnabled. (CUR-913/CUR-957)
const workspaceOrgCreationEnabledMock = vi.fn(() => true);
vi.mock("$lib/chat/server/workspacesGate", () => ({
	workspaceOrgCreationEnabled: () => workspaceOrgCreationEnabledMock(),
}));

// An instance that has not polled PostHog reads every flag as its OFF fallback, so the route must poll
// before the org gate (CUR-1959).
const ensureFlagsPolledMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/flags", () => ({ ensureFlagsPolled: () => ensureFlagsPolledMock() }));

import { GET, POST } from "./+server";

// A real, non-organization path, so the organization-route gate stays inert for the sign-in tests.
function fakeEvent(pathname = "/chat/api/auth/callback/google") {
	return { url: new URL(`https://develop.aipotluck.org${pathname}`) } as Parameters<typeof GET>[0];
}
const event = fakeEvent();

describe("Better Auth catch-all route — sign-in reaches Better Auth with no flag in the way (CUR-1961)", () => {
	beforeEach(() => {
		getAuthHandler.mockReset();
		workspaceOrgCreationEnabledMock.mockReset().mockReturnValue(true);
	});

	it("GET reaches Better Auth's own handler", async () => {
		getAuthHandler.mockResolvedValueOnce(new Response("ok"));

		const res = await GET(event);

		expect(getAuthHandler).toHaveBeenCalledWith(event);
		expect(await res.text()).toBe("ok");
	});

	it("POST reaches Better Auth's own handler — the request shape a real sign-in submission takes", async () => {
		getAuthHandler.mockResolvedValueOnce(new Response("ok"));

		const res = await POST(event);

		expect(getAuthHandler).toHaveBeenCalledWith(event);
		expect(await res.text()).toBe("ok");
	});
});

describe("Better Auth catch-all route — organization sub-path gate (CUR-913, CUR-957)", () => {
	beforeEach(() => {
		getAuthHandler.mockReset();
		workspaceOrgCreationEnabledMock.mockReset();
	});

	it("404s an organization route when workspaceOrgCreationEnabled() is off, without reaching Better Auth's handler", async () => {
		workspaceOrgCreationEnabledMock.mockReturnValue(false);
		const orgEvent = fakeEvent("/chat/api/auth/organization/create");

		await expect(GET(orgEvent)).rejects.toMatchObject({ status: 404 });
		expect(getAuthHandler).not.toHaveBeenCalled();
	});

	it("leaves a non-organization route (sign-in callback) untouched when workspaceOrgCreationEnabled() is off", async () => {
		workspaceOrgCreationEnabledMock.mockReturnValue(false);
		getAuthHandler.mockResolvedValueOnce(new Response("ok"));
		const signinEvent = fakeEvent("/chat/api/auth/callback/google");

		const res = await GET(signinEvent);

		expect(getAuthHandler).toHaveBeenCalledWith(signinEvent);
		expect(await res.text()).toBe("ok");
	});

	it("reaches an organization route when workspaceOrgCreationEnabled() is on", async () => {
		workspaceOrgCreationEnabledMock.mockReturnValue(true);
		getAuthHandler.mockResolvedValueOnce(new Response("ok"));
		const orgEvent = fakeEvent("/chat/api/auth/organization/create");

		const res = await GET(orgEvent);

		expect(getAuthHandler).toHaveBeenCalledWith(orgEvent);
		expect(await res.text()).toBe("ok");
	});
});
