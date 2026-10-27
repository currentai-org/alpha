import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookies } from "@sveltejs/kit";

vi.mock("$lib/chat/server/config", () => ({ config: { BETTER_AUTH_SECRET: "test-secret-for-handoff" } }));
// The real auth module, so the "owns no data" decision is the one the app makes; only the cookie
// write is a spy, and the database is the same shape auth.guestCookie.spec.ts mocks.
vi.mock("$lib/chat/server/database", () => ({
	collections: {
		sessions: { findOne: vi.fn(async () => null) },
		conversations: { findOne: vi.fn(async () => null) },
		settings: { findOne: vi.fn(async () => null) },
	},
}));
vi.mock("$app/server", () => ({ getRequestEvent: () => ({ getClientAddress: () => "203.0.113.5" }) }));
vi.mock("$lib/chat/server/betterAuth", () => ({ getAuth: () => ({ api: { getSession: vi.fn(async () => null) } }) }));
const refreshSessionCookie = vi.fn();
vi.mock("$lib/chat/server/auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/auth")>()),
	refreshSessionCookie: (...args: unknown[]) => refreshSessionCookie(...args),
}));

const { acceptGuestHandoff, guestHandoffPage } = await import("$lib/chat/server/guestHandoff");
const { collections } = await import("$lib/chat/server/database");
const { sha256 } = await import("$lib/chat/utils/sha256");
/* eslint-disable @typescript-eslint/no-explicit-any */
const sessionsFindOne = vi.mocked((collections as any).sessions.findOne);
const conversationsFindOne = vi.mocked((collections as any).conversations.findOne);
const settingsFindOne = vi.mocked((collections as any).settings.findOne);
/* eslint-enable @typescript-eslint/no-explicit-any */

const GUEST = "0b9f4d52-6a8e-4f1c-9a43-2f6d8c1e7a10.c2lnbmF0dXJl";

function jar(values: Record<string, string>): Cookies {
	return {
		get: (name: string) => values[name],
		getAll: () => Object.entries(values).map(([name, value]) => ({ name, value })),
	} as unknown as Cookies;
}

async function handoffForm(token = GUEST, now = Date.now()) {
	const page = guestHandoffPage(jar({ "hf-chat": token }), new URL("https://alpha.aipotluck.org/chat/conversation/c1?x=1"), now)!;
	const html = await page.text();
	const value = (name: string) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))![1].replace(/&amp;/g, "&");
	return { page, html, h: value("h"), next: value("next") };
}

function post(fields: Record<string, string>, origin: string | null = "https://www.aipotluck.org") {
	const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
	if (origin) headers.set("origin", origin);
	return new Request("https://alpha.aipotluck.org/chat/guest-handoff", {
		method: "POST",
		headers,
		body: new URLSearchParams(fields),
	});
}

beforeEach(() => {
	refreshSessionCookie.mockReset();
	sessionsFindOne.mockReset().mockResolvedValue(null);
	conversationsFindOne.mockReset().mockResolvedValue(null);
	settingsFindOne.mockReset().mockResolvedValue(null);
});

/** Make `token`'s session own a row in `find` (the rest stay empty). */
async function owns(find: typeof conversationsFindOne, token: string) {
	const sessionId = await sha256(token);
	find.mockImplementation(async (q: { sessionId?: string }) => (q?.sessionId === sessionId ? { sessionId } : null));
}

// A guest's conversations belong to a host-only cookie; this carries it from www or chat. to
// alpha without putting the session in a URL. (CUR-4439)
describe("guest handoff", () => {
	it("gives alpha the guest's own cookie value and lands them on the page they were opening", async () => {
		const { h, next } = await handoffForm();
		const cookies = jar({});
		const result = await acceptGuestHandoff(post({ h, next }), cookies);
		expect(result).toEqual({ next: "/chat/conversation/c1?x=1", outcome: "adopted" });
		expect(refreshSessionCookie).toHaveBeenCalledWith(cookies, GUEST);
	});

	it("never puts the session value in the page as plain text, a URL or anywhere but the sealed field", async () => {
		const { page, html } = await handoffForm();
		expect(html).not.toContain(GUEST);
		expect(page.headers.get("cache-control")).toBe("no-store");
		// no-referrer would make the browser send Origin: null, which alpha refuses.
		expect(page.headers.get("referrer-policy")).toBe("strict-origin");
		expect(page.headers.get("content-security-policy")).toContain("form-action https://alpha.aipotluck.org");
	});

	it("sets nothing from a post by any other site, so nobody can plant their session in a visitor, and still lands them", async () => {
		const { h, next } = await handoffForm();
		for (const origin of ["https://evil.example", "https://alpha.aipotluck.org", null]) {
			const result = await acceptGuestHandoff(post({ h, next }, origin), jar({}));
			expect(result, String(origin)).toEqual({ next: "/chat/conversation/c1?x=1", outcome: "bad-origin" });
		}
		expect(refreshSessionCookie).not.toHaveBeenCalled();
	});

	it("accepts a post from chat.aipotluck.org, the old chat host", async () => {
		const { h, next } = await handoffForm();
		const result = await acceptGuestHandoff(post({ h, next }, "https://chat.aipotluck.org"), jar({}));
		expect(result.outcome).toBe("adopted");
	});

	it("sets nothing from a value older than a minute", async () => {
		const { h, next } = await handoffForm(GUEST, Date.now() - 61_000);
		const result = await acceptGuestHandoff(post({ h, next }), jar({}));
		expect(result.outcome).toBe("expired");
		expect(refreshSessionCookie).not.toHaveBeenCalled();
	});

	it("sets nothing from a tampered or missing value, and still lands the guest", async () => {
		const { h } = await handoffForm();
		const tampered = h.slice(0, -4) + (h.endsWith("AAAA") ? "BBBB" : "AAAA");
		const cases: Record<string, string>[] = [{ h: tampered, next: "/chat" }, { next: "/chat" }];
		for (const fields of cases) {
			expect(await acceptGuestHandoff(post(fields), jar({}))).toEqual({ next: "/chat", outcome: "unreadable" });
		}
		expect(refreshSessionCookie).not.toHaveBeenCalled();
	});

	it("never replaces a guest session on alpha that owns a conversation, or touches a visitor signed in on alpha", async () => {
		const { h, next } = await handoffForm();
		await owns(conversationsFindOne, "other");
		expect((await acceptGuestHandoff(post({ h, next }), jar({ "hf-chat": "other" }))).outcome).toBe("has-guest");
		expect(
			(await acceptGuestHandoff(post({ h, next }), jar({ "__Host-aip.session_token": "s" }))).outcome
		).toBe("signed-in");
		expect(refreshSessionCookie).not.toHaveBeenCalled();
	});

	// A guest who opened alpha once before the switch holds an empty session there, and
	// keeping it would cost them every conversation they had on www. (CUR-4445)
	it("replaces an alpha guest session that owns nothing with the one handed over from www", async () => {
		const { h, next } = await handoffForm();
		const cookies = jar({ "hf-chat": "empty-alpha-guest" });
		const result = await acceptGuestHandoff(post({ h, next }), cookies);
		expect(result).toEqual({ next: "/chat/conversation/c1?x=1", outcome: "replaced-empty-guest" });
		expect(refreshSessionCookie).toHaveBeenCalledWith(cookies, GUEST);
		expect(conversationsFindOne).toHaveBeenCalledWith({ sessionId: await sha256("empty-alpha-guest") });
	});

	it("replaces an alpha guest session that owns only a settings row, such as a dismissed welcome modal", async () => {
		const { h, next } = await handoffForm();
		await owns(settingsFindOne, "alpha-guest");
		const cookies = jar({ "hf-chat": "alpha-guest" });
		expect((await acceptGuestHandoff(post({ h, next }), cookies)).outcome).toBe("replaced-empty-guest");
		expect(refreshSessionCookie).toHaveBeenCalledWith(cookies, GUEST);
	});

	it("keeps an alpha session cookie that has a sessions row, which is a signed-in session and not a guest", async () => {
		const { h, next } = await handoffForm();
		await owns(sessionsFindOne, "oauth-session");
		expect((await acceptGuestHandoff(post({ h, next }), jar({ "hf-chat": "oauth-session" }))).outcome).toBe("has-guest");
		expect(refreshSessionCookie).not.toHaveBeenCalled();
	});

	it("never replaces anything for a signed-in visitor whose session cookie owns no guest rows", async () => {
		const { h, next } = await handoffForm();
		const result = await acceptGuestHandoff(
			post({ h, next }),
			jar({ "hf-chat": "better-auth-token", "__Host-aip.session_token": "s" })
		);
		expect(result.outcome).toBe("signed-in");
		expect(refreshSessionCookie).not.toHaveBeenCalled();
	});

	it("lands an off-site next on /chat rather than redirecting anywhere the post names", async () => {
		const { h } = await handoffForm();
		expect((await acceptGuestHandoff(post({ h, next: "//evil.example/x" }), jar({}))).next).toBe("/chat");
	});

	it("builds no page for a visitor with no guest cookie", () => {
		expect(guestHandoffPage(jar({}), new URL("https://alpha.aipotluck.org/chat"))).toBeNull();
	});
});
