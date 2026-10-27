// The new-device notice decides from message_events rows keyed on the browser's device cookie
// (CUR-4231), then sends through Resend. Both are mocked here with in-memory stand-ins, so this pins the decision and the
// failure posture; new-device-notice.spec.ts drives the real thing on a preview. (CUR-4181)
import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));
const warnMock = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: warnMock },
}));
vi.mock("$lib/chat/server/errorTracking", () => ({ captureServerException: vi.fn() }));

const flagState = { on: true };
vi.mock("$lib/chat/server/flags", () => ({
	fuzzOverrideValue: () => undefined,
	accountFlagValues: async () => new Map([["new-device-notice", flagState.on]]),
	flagEnabledOr: () => false,
}));

// message_events, as live rows per key
const events = new Map<string, number>();
const k = (key: object) => JSON.stringify(key, Object.keys(key).sort());
function matching(key: Record<string, unknown>) {
	let n = 0;
	for (const [stored, count] of events) {
		const row = JSON.parse(stored) as Record<string, unknown>;
		if (Object.entries(key).every(([f, v]) => row[f] === v)) n += count;
	}
	return n;
}
vi.mock("$lib/chat/server/db/eventWindow", () => ({
	countLiveEvents: async (key: Record<string, unknown>) => matching(key),
	recordEvent: async (key: object) => void events.set(k(key), (events.get(k(key)) ?? 0) + 1),
	clearEvents: async (key: object) => void events.delete(k(key)),
}));
const quota = { allowed: true };
vi.mock("$lib/chat/server/db/targetEmailRate", () => ({
	targetEmailSendAllowed: async () => quota.allowed,
	recordTargetEmailSend: async () => {},
}));

// the user row
const db = { email: "ada@example.com" };
const inserted: unknown[] = [];
vi.mock("$lib/chat/server/db/client", () => ({
	getDb: () => ({
		select: (cols: Record<string, unknown>) => ({
			from: () => ({
				where: () =>
					"email" in cols ? { limit: async () => [{ email: db.email, emailVerified: true }] } : Promise.resolve([]),
			}),
		}),
		insert: () => ({ values: async (row: unknown) => void inserted.push(row) }),
	}),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const MAC_CHROME =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const WIN_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
// A browser is its device id; each name below stands for one browser's cookie.
// As betterAuth's session hook does: read the flag for the account, then notice only when it is on.
const signIn = async (userAgent: string, deviceId: string = userAgent) => {
	const { newDeviceNoticeAccount, noticeNewDevice } = await import("./newDeviceNotice");
	const account = await newDeviceNoticeAccount("u1");
	if (!account) return;
	await noticeNewDevice({
		userId: "u1",
		email: account.email,
		deviceId,
		userAgent,
		origin: "https://develop.aipotluck.org",
	});
};
const resendCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("api.resend.com"));

beforeEach(() => {
	events.clear();
	inserted.length = 0;
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
	warnMock.mockReset();
	cfg.RESEND_API_KEY = "re_test";
	flagState.on = true;
	quota.allowed = true;
	db.email = "ada@example.com";
});

describe("noticeNewDevice (CUR-4181)", { timeout: 60_000 }, () => {
	it("sends nothing for an account's first device, since there is nothing to compare it with", async () => {
		await signIn(MAC_CHROME);
		expect(resendCalls()).toHaveLength(0);
	});

	it("sends nothing on a repeat sign-in from a device already on record", async () => {
		await signIn(MAC_CHROME);
		await signIn(MAC_CHROME);
		await signIn(MAC_CHROME);
		expect(resendCalls()).toHaveLength(0);
	});

	it("mails the account once when a second device signs in, naming it and linking to Active sessions", async () => {
		await signIn(MAC_CHROME);
		await signIn(WIN_FIREFOX);
		expect(resendCalls()).toHaveLength(1);
		const body = JSON.parse(resendCalls()[0][1].body as string) as { to: string[]; text: string };
		expect(body.to).toEqual(["ada@example.com"]);
		expect(body.text).toContain("Firefox on Windows");
		expect(body.text).toContain("https://develop.aipotluck.org/chat/settings/account");
		await signIn(WIN_FIREFOX);
		expect(resendCalls(), "the second device was mailed about again on its next sign-in").toHaveLength(1);
	});

	it("mails the account when a second browser with the same browser and system signs in", async () => {
		await signIn(MAC_CHROME, "owner-laptop");
		await signIn(MAC_CHROME, "someone-elses-laptop");
		expect(resendCalls(), "a different browser on Chrome on macOS passed as the owner's").toHaveLength(1);
		const body = JSON.parse(resendCalls()[0][1].body as string) as { text: string };
		expect(body.text).toContain("Chrome on macOS");
	});

	it("answers no account with the flag off, so the hook sets no device cookie", async () => {
		const { newDeviceNoticeAccount } = await import("./newDeviceNotice");
		flagState.on = false;
		expect(await newDeviceNoticeAccount("u1")).toBeNull();
		flagState.on = true;
		expect(await newDeviceNoticeAccount("u1")).toEqual({ email: "ada@example.com" });
	});

	it("resolves without throwing when Resend refuses the send, so the sign-in it follows stands", async () => {
		await signIn(MAC_CHROME);
		fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
		await expect(signIn(WIN_FIREFOX)).resolves.toBeUndefined();
		fetchMock.mockRejectedValue(new Error("network down"));
		await expect(signIn("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1")).resolves.toBeUndefined();
		expect(warnMock).toHaveBeenCalled();
	});

	it("sends nothing past the daily cap for the address", async () => {
		await signIn(MAC_CHROME);
		quota.allowed = false;
		await signIn(WIN_FIREFOX);
		expect(resendCalls()).toHaveLength(0);
	});

	it("sends nothing with the flag off", async () => {
		flagState.on = false;
		await signIn(MAC_CHROME);
		await signIn(WIN_FIREFOX);
		expect(resendCalls()).toHaveLength(0);
	});

	it("writes a test address's notice to the verification table instead of calling Resend", async () => {
		db.email = "e2e-x@example.org";
		await signIn(MAC_CHROME);
		await signIn(WIN_FIREFOX);
		expect(resendCalls()).toHaveLength(0);
		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({ identifier: "new-device-notice-e2e-x@example.org" });
	});
});

// The cookie half: better-auth's signed-cookie helpers, faked as a jar that drops a bad signature.
function cookieContext(jar: Map<string, string>) {
	const set: { name: string; value: string; options?: object }[] = [];
	const ctx = {
		getSignedCookie: async (key: string) => jar.get(key) ?? null,
		setSignedCookie: async (key: string, value: string, _secret: string, options?: object) => {
			set.push({ name: key, value, options });
			jar.set(key, value);
			return value;
		},
		context: {
			secret: "s",
			createAuthCookie: (name: string, attributes?: object) => ({
				name: `better-auth.${name}`,
				attributes: { httpOnly: true, ...attributes },
			}),
		},
	};
	return { ctx, set };
}

describe("deviceIdForSignIn (CUR-4231)", () => {
	it("mints a token for a browser with no cookie and gives the same id on its next sign-in", async () => {
		const { deviceIdForSignIn } = await import("./newDeviceNotice");
		const jar = new Map<string, string>();
		const { ctx, set } = cookieContext(jar);
		const first = await deviceIdForSignIn(ctx);
		const again = await deviceIdForSignIn(ctx);
		expect(again).toBe(first);
		expect(set[0].options).toMatchObject({ httpOnly: true, maxAge: 180 * 24 * 60 * 60 });
	});

	it("gives two browsers different ids and never returns the token itself", async () => {
		const { deviceIdForSignIn } = await import("./newDeviceNotice");
		const a = cookieContext(new Map());
		const b = cookieContext(new Map());
		const idA = await deviceIdForSignIn(a.ctx);
		expect(await deviceIdForSignIn(b.ctx)).not.toBe(idA);
		expect(idA).not.toBe(a.set[0].value);
	});
});
