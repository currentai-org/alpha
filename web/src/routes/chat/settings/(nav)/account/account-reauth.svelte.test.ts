import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// "Sign in again" (shown once Better Auth calls the session too old to list sessions) signs out
// and sends the person to /login (CUR-4011). A refused sign-out must stop there with a message:
// going on to /login with the session still live would bounce straight back here. The page is
// mounted bare, with the server's "not fresh" answer handed in as data: reaching that state in a
// scenario needs a session more than a day old.

vi.mock("$app/navigation", () => ({ goto: vi.fn(async () => {}), invalidateAll: vi.fn(async () => {}) }));
vi.mock("$app/state", () => ({
	page: { url: new URL("http://localhost/chat/settings/account"), data: { dataExportEnabled: false } },
}));

const signOut = vi.hoisted(() => vi.fn());
vi.mock("$lib/chat/authClient", () => ({
	authClient: {
		signOut,
		listAccounts: vi.fn(async () => ({ data: [], error: null })),
		listSessions: vi.fn(async () => ({ data: null, error: { code: "SESSION_NOT_FRESH" } })),
		getSession: vi.fn(async () => ({ data: null, error: null })),
		passkey: { listUserPasskeys: vi.fn(async () => ({ data: [], error: null })) },
	},
}));

import Page from "./+page.svelte";

const notFreshData = {
	providers: { google: false, github: false },
	nextExportAt: null,
	initial: {
		accounts: { ok: true, value: [] },
		passkeys: { ok: true, value: [] },
		sessions: { ok: false, code: "SESSION_NOT_FRESH" },
		session: {
			ok: true,
			value: { session: { token: "t" }, user: { email: "person@example.org", name: "" } },
		},
	},
};

describe("account page: Sign in again", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		signOut.mockReset();
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});
	afterEach(() => {
		fetchSpy.mockRestore();
		cleanup();
	});

	it.each([
		["answers with { error }", () => signOut.mockResolvedValue({ data: null, error: { status: 503 } })],
		["throws", () => signOut.mockRejectedValue(new TypeError("Failed to fetch"))],
	])(
		"a sign-out that %s says the person is still signed in and leaves the button ready to try again",
		async (_label, arrange) => {
			arrange();
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			render(Page, { props: { data: notFreshData as any } });

			const button = page.getByRole("button", { name: "Sign in again" });
			await button.click();

			await expect
				.element(page.getByText(/Signing out didn't go through, so you're still signed in here/))
				.toBeVisible();
			await expect.element(page.getByRole("button", { name: "Sign in again" })).toBeEnabled();
			expect(signOut).toHaveBeenCalledTimes(1);
			const logoutCalls = fetchSpy.mock.calls.filter((args: unknown[]) => String(args[0]).endsWith("/logout"));
			expect(logoutCalls, "the page went on to /logout after a refused sign-out").toHaveLength(0);
		}
	);
});
