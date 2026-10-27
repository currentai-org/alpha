import { describe, it, expect, beforeEach, vi } from "vitest";

// The account route is signed-in-only content (CUR-580), and the server load enforces it (CUR-850):
// a client-side check gated on the site-wide automaticLogin flag does nothing when login is merely
// offered, not mandatory. A signed-out visitor needs a redirect rather than a rendered page whose
// four client loads all come back unauthenticated.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));
const { exportEnabled, thunderboltEnabled, nextExportAt } = vi.hoisted(() => ({
	exportEnabled: vi.fn(() => false),
	thunderboltEnabled: vi.fn(() => false),
	nextExportAt: vi.fn(async (_id: unknown, _now?: Date, _type?: string): Promise<Date | null> => null),
}));
vi.mock("$lib/chat/server/dataPortability", () => ({
	dataExportEnabled: exportEnabled,
	thunderboltExportEnabled: thunderboltEnabled,
	nextExportAt,
}));

// The load reads the page's four Better Auth sections server-side. Each stub resolves by
// default; a test makes one throw the way Better Auth's APIError does, with `body.code`. (CUR-2710)
const api = vi.hoisted(() => ({
	listUserAccounts: vi.fn(),
	listPasskeys: vi.fn(),
	listSessions: vi.fn(),
	getSession: vi.fn(),
}));
vi.mock("$lib/chat/server/betterAuth", () => ({ getAuth: () => ({ api }) }));

const { load } = await import("./+page.server");

type User = { id: string } | undefined;
const setHeaders = vi.fn();
const requestHeaders = new Headers({ cookie: "session=abc" });
function fakeEvent(user: User) {
	return {
		locals: { user },
		setHeaders,
		request: new Request("https://develop.aipotluck.org/chat/settings/account", {
			headers: requestHeaders,
		}),
		url: new URL("https://develop.aipotluck.org/chat/settings/account"),
	} as unknown as Parameters<typeof load>[0];
}

const ACCOUNTS = [{ id: "a1", providerId: "credential" }];
const PASSKEYS = [{ id: "p1", deviceType: "multiDevice" }];
const SESSIONS = [{ id: "s1", token: "t1", userAgent: "Mozilla/5.0" }];
const SESSION = { session: { token: "t1" }, user: { email: "x@example.org", name: "X" } };

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	exportEnabled.mockReset().mockReturnValue(false);
	thunderboltEnabled.mockReset().mockReturnValue(false);
	nextExportAt.mockReset().mockResolvedValue(null);
	setHeaders.mockReset();
	api.listUserAccounts.mockReset().mockResolvedValue(ACCOUNTS);
	api.listPasskeys.mockReset().mockResolvedValue(PASSKEYS);
	api.listSessions.mockReset().mockResolvedValue(SESSIONS);
	api.getSession.mockReset().mockResolvedValue(SESSION);
});

describe("account +page.server load — the page's sections arrive with the HTML (CUR-2710)", () => {
	it("reads accounts, passkeys, sessions and the session with the visitor's own request headers", async () => {
		const result = (await load(fakeEvent({ id: "user-1" }))) as { initial: unknown };
		expect(result.initial).toEqual({
			accounts: { ok: true, value: ACCOUNTS },
			passkeys: { ok: true, value: PASSKEYS },
			sessions: { ok: true, value: SESSIONS },
			session: { ok: true, value: SESSION },
		});
		for (const call of Object.values(api)) {
			expect(call).toHaveBeenCalledWith({ headers: requestHeaders });
		}
	});

	it("returns a failed section as not-ok with its code, still rendering the others, so the page can fetch just that one", async () => {
		api.listSessions.mockRejectedValue(
			Object.assign(new Error("Session is not fresh"), { body: { code: "SESSION_NOT_FRESH" } })
		);
		api.listPasskeys.mockRejectedValue(new Error("db down"));
		const result = (await load(fakeEvent({ id: "user-1" }))) as {
			initial: Record<string, unknown>;
		};
		expect(result.initial.sessions).toEqual({ ok: false, code: "SESSION_NOT_FRESH" });
		expect(result.initial.passkeys).toEqual({ ok: false, code: null });
		expect(result.initial.accounts).toEqual({ ok: true, value: ACCOUNTS });
	});
});

// The page renders on the server, and that HTML carries the visitor's session (CUR-2146).
describe("account +page.server load — server-rendered, never shared-cached", () => {
	it("marks a signed-in render private and uncacheable, since it carries that visitor's session", async () => {
		await load(fakeEvent({ id: "user-1" }));
		expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
	});
});

describe("account +page.server load — signed-in-only, enforced server-side", () => {
	it("redirects an unauthenticated visitor to login instead of rendering the page", async () => {
		let threw: { status?: number; location?: string } = {};
		try {
			await load(fakeEvent(undefined));
		} catch (e) {
			threw = e as { status?: number; location?: string };
		}
		expect(threw.status).toBe(302);
		expect(threw.location).toBe(
			"/chat/login?next=%2Fchat%2Fsettings%2Faccount"
		);
	});

	it("returns provider config for a signed-in visitor, never throwing", async () => {
		cfg.GOOGLE_CLIENT_ID = "google-id";
		const result = await load(fakeEvent({ id: "user-1" }));
		expect(result).toMatchObject({ providers: { google: true, github: false }, nextExportAt: null });
	});

	it("says when the next export is possible while the last one's hour is running, so the page never links to a 429", async () => {
		exportEnabled.mockReturnValue(true);
		nextExportAt.mockResolvedValue(new Date("2026-09-23T05:00:00.000Z"));
		const result = (await load(fakeEvent({ _id: "abc", id: "user-1" } as never))) as {
			nextExportAt: string | null;
		};
		expect(result.nextExportAt).toBe("2026-09-23T05:00:00.000Z");
		expect(nextExportAt).toHaveBeenCalledWith("abc");
	});

	it("says when the next Thunderbolt file is possible, read from its own window and not the ZIP's (CUR-2407)", async () => {
		exportEnabled.mockReturnValue(true);
		thunderboltEnabled.mockReturnValue(true);
		nextExportAt.mockImplementation(async (_id, _now, type) =>
			type === "export-thunderbolt" ? new Date("2026-10-20T07:30:00.000Z") : null
		);
		const result = (await load(fakeEvent({ _id: "abc", id: "user-1" } as never))) as {
			nextExportAt: string | null;
			nextThunderboltExportAt: string | null;
		};
		expect(result.nextExportAt).toBeNull();
		expect(result.nextThunderboltExportAt).toBe("2026-10-20T07:30:00.000Z");
	});
});
