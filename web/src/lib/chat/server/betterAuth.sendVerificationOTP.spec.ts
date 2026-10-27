/**
 * sendVerificationOTP is extracted to a standalone export precisely so this doesn't need a
 * live betterAuth() instance (buildAuth() eagerly calls getDb(), which throws without DATABASE_URL) —
 * same move betterAuth.accountMerge.spec.ts makes for handleOAuthUserInfo, applied to a pure function
 * instead of a DB-backed one. (CUR-518)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const infoMock = vi.fn();
const errorMock = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: infoMock, error: errorMock, warn: vi.fn() },
	// The refused sends are security lines; one mock keeps the assertions on either logger. (CUR-4143)
	securityLogger: { info: infoMock, error: errorMock, warn: vi.fn() },
}));

// `dev` decides whether the no-Resend stub may log the code at all. Mutable so one file covers both.
const env = { dev: false };
vi.mock("$app/environment", () => ({
	get dev() {
		return env.dev;
	},
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// betterAuth.ts now imports the DB-backed target-email backstop at module level — mocked here
// the same way config/logger are, rather than exercised for real, since this whole file's premise is
// no live DB. Defaults to "always allowed" so it doesn't interfere with the in-memory-limiter test below. (CUR-920)
const targetEmailRateState = { allowed: true };
const targetEmailSendAllowedMock = vi.fn(async () => targetEmailRateState.allowed);
const recordTargetEmailSendMock = vi.fn(async () => {});
// The (ip, target) pair check — same "mock the whole module" premise.
const otpSourceRateState = { allowed: true };
const otpSourceSendAllowedMock = vi.fn(async () => otpSourceRateState.allowed);
const recordOtpSourceSendMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/db/targetEmailRate", () => ({
	targetEmailSendAllowed: targetEmailSendAllowedMock,
	recordTargetEmailSend: recordTargetEmailSendMock,
	otpSourceSendAllowed: otpSourceSendAllowedMock,
	recordOtpSourceSend: recordOtpSourceSendMock,
}));

// The daily caps in signInCodeRate.ts run for real over an in-memory event store, and the
// account lookup reads from `existingAccounts`, so a test can say which addresses already have one. (CUR-4172)
const eventCounts = new Map<string, number>();
const eventKey = (k: { type: string; userId?: string; ipHash?: string }) => `${k.type}:${k.userId ?? k.ipHash}`;
vi.mock("$lib/chat/server/db/eventWindow", () => ({
	underEventLimit: async (k: { type: string }, max: number) => (eventCounts.get(eventKey(k)) ?? 0) < max,
	recordEvent: async (k: { type: string }) => {
		eventCounts.set(eventKey(k), (eventCounts.get(eventKey(k)) ?? 0) + 1);
	},
}));
const existingAccounts = new Set<string>();
vi.mock("$lib/chat/server/db/signInCodeRate", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/db/signInCodeRate")>()),
	accountExistsForEmail: async (email: string) => existingAccounts.has(email.toLowerCase()),
}));
const tripMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/alerting", () => ({ recordRateLimitTrip: tripMock }));

beforeEach(() => {
	eventCounts.clear();
	existingAccounts.clear();
	tripMock.mockClear();
	for (const k of Object.keys(cfg)) delete cfg[k];
	env.dev = false;
	infoMock.mockReset();
	errorMock.mockReset();
	fetchMock.mockReset();
	targetEmailRateState.allowed = true;
	targetEmailSendAllowedMock.mockClear();
	recordTargetEmailSendMock.mockClear();
	otpSourceRateState.allowed = true;
	otpSourceSendAllowedMock.mockClear();
	recordOtpSourceSendMock.mockClear();
});

describe("sendVerificationOTP (CUR-518)", () => {
	// 120000ms, not the 30000ms default (same bump as server-live's own tier in vite.config.ts) — under a
	// loaded host the test can need most of a minute of actual execution alone (not just import/transform).
	it(
		"in dev, logs the stub (with the code) and never calls fetch when RESEND_API_KEY is unset",
		async () => {
			env.dev = true;
			const { sendVerificationOTP } = await import("./betterAuth");
			await sendVerificationOTP({ email: "a@example.org", otp: "123456", type: "sign-in" });

			expect(fetchMock).not.toHaveBeenCalled();
			expect(infoMock).toHaveBeenCalledWith(
				expect.objectContaining({ email: "a@example.org", otp: "123456" }),
				expect.stringContaining("stub")
			);
		},
		120000
	);

	it(
		"outside dev, an unset RESEND_API_KEY logs an error and the code appears in NO log line",
		async () => {
			const { sendVerificationOTP } = await import("./betterAuth");
			await sendVerificationOTP({ email: "a@example.org", otp: "123456", type: "sign-in" });

			expect(fetchMock).not.toHaveBeenCalled();
			expect(errorMock).toHaveBeenCalledTimes(1);
			const everything = JSON.stringify([...infoMock.mock.calls, ...errorMock.mock.calls]);
			expect(everything).not.toContain("123456");
			expect(everything).not.toContain("a@example.org");
		},
		120000
	);

	it(
		"POSTs to Resend with the right shape and logs success when RESEND_API_KEY is set",
		async () => {
			cfg.RESEND_API_KEY = "re_test_key";
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "resend-id-1" }), { status: 200 })
			);
			const { sendVerificationOTP } = await import("./betterAuth");
			await sendVerificationOTP({ email: "b@example.com", otp: "654321", type: "sign-in" });

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe("https://api.resend.com/emails");
			expect(init.method).toBe("POST");
			expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
			const body = JSON.parse(init.body as string);
			expect(body.from).toBe("AI Potluck <noreply@mail.aipotluck.org>");
			expect(body.to).toEqual(["b@example.com"]);
			expect(body.subject).not.toContain("654321");
			expect(body.text).toContain("654321");

			expect(errorMock).not.toHaveBeenCalled();
			expect(infoMock).toHaveBeenCalledWith(
				expect.objectContaining({ resendId: "resend-id-1" }),
				expect.stringContaining("sent")
			);
			// The address is the thing being delivered to, not a thing to retain in Axiom.
			expect(JSON.stringify(infoMock.mock.calls)).not.toContain("b@example.com");
		},
		120000
	);

	it(
		"logs the failure loudly (not thrown) when Resend returns a non-ok response",
		async () => {
			cfg.RESEND_API_KEY = "re_test_key";
			fetchMock.mockResolvedValueOnce(new Response("bad key", { status: 401 }));
			const { sendVerificationOTP } = await import("./betterAuth");
			await expect(
				sendVerificationOTP({ email: "c@example.com", otp: "111111", type: "sign-in" })
			).resolves.toBeUndefined();

			expect(errorMock).toHaveBeenCalledWith(
				expect.objectContaining({ status: 401 }),
				expect.stringContaining("Resend")
			);
		},
		120000
	);

	it(
		"caps real sends per TARGET EMAIL, not just Better Auth's own per-IP limit",
		async () => {
			cfg.RESEND_API_KEY = "re_test_key";
			// A fresh Response per call — mockResolvedValue would reuse one Response, and a Response
			// body can only be read once (res.json() consumes it), which the sends below need thrice.
			fetchMock.mockImplementation(
				async () => new Response(JSON.stringify({ id: "resend-id-x" }), { status: 200 })
			);
			const { sendVerificationOTP } = await import("./betterAuth");
			const send = () =>
				sendVerificationOTP({ email: "d@example.com", otp: "222222", type: "sign-in" });

			await send();
			await send();
			await send();
			expect(fetchMock).toHaveBeenCalledTimes(3);

			infoMock.mockClear();
			await send(); // 4th within the window — must not reach Resend

			expect(fetchMock).toHaveBeenCalledTimes(3);
			expect(infoMock).toHaveBeenCalledWith(
				expect.objectContaining({ type: "sign-in" }),
				expect.stringContaining("rate-limited")
			);
		},
		120000
	);

	it(
		"blocks a send when the DB-backed target-email backstop reports the cap reached (CUR-920), independently of the in-memory limiter",
		async () => {
			cfg.RESEND_API_KEY = "re_test_key";
			targetEmailRateState.allowed = false; // the in-memory limiter alone would allow this send
			const { sendVerificationOTP } = await import("./betterAuth");

			await sendVerificationOTP({ email: "h@example.com", otp: "333333", type: "sign-in" });

			expect(fetchMock).not.toHaveBeenCalled();
			expect(infoMock).toHaveBeenCalledWith(
				expect.objectContaining({ type: "sign-in" }),
				expect.stringContaining("rate-limited by target address (DB-backed)")
			);
			expect(recordTargetEmailSendMock).not.toHaveBeenCalled();
		},
		120000
	);

	it(
		"blocks a send when the (ip, target) source-pair backstop reports the cap reached (CUR-920 review follow-up), independently of the target-only checks — and, critically, never touches the target-wide counter either",
		async () => {
			cfg.RESEND_API_KEY = "re_test_key";
			otpSourceRateState.allowed = false; // target-only checks alone would allow this send
			const { sendVerificationOTP } = await import("./betterAuth");

			await sendVerificationOTP({ email: "i@example.com", otp: "444444", type: "sign-in" });

			expect(fetchMock).not.toHaveBeenCalled();
			expect(infoMock).toHaveBeenCalledWith(
				expect.objectContaining({ type: "sign-in" }),
				expect.stringContaining("rate-limited by (source, target) pair")
			);
			expect(recordOtpSourceSendMock).not.toHaveBeenCalled();
			// otpSourceSendAllowed must be checked, and denied, before recordTargetEmailSend runs. Otherwise a
			// pair-blocked attempt from one source still consumes a slot of the victim's target-wide budget,
			// letting one source exhaust the whole budget in exactly the number of requests this cap exists to prevent.
			expect(targetEmailSendAllowedMock).not.toHaveBeenCalled();
			expect(recordTargetEmailSendMock).not.toHaveBeenCalled();
		},
		120000
	);

	it(
		"records the (source, target) pair send only after every earlier check passes",
		async () => {
			cfg.RESEND_API_KEY = "re_test_key";
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "resend-id-y" }), { status: 200 })
			);
			const { sendVerificationOTP } = await import("./betterAuth");

			await sendVerificationOTP({ email: "j@example.com", otp: "555555", type: "sign-in" });

			expect(otpSourceSendAllowedMock).toHaveBeenCalledWith(null, "j@example.com"); // no live
			// SvelteKit request in this unit test — currentClientAddress() falls back to null, same
			// fail-open posture the underlying module already applies to a missing IP.
			expect(recordOtpSourceSendMock).toHaveBeenCalledWith(null, "j@example.com", 10 * 60 * 1000);
		},
		120000
	);

	it(
		"suppresses the send for reserved test domains (CUR-1254), without touching any rate-limit state",
		async () => {
			cfg.RESEND_API_KEY = "re_test_key";
			const { sendVerificationOTP } = await import("./betterAuth");

			await sendVerificationOTP({ email: "e2e-abc123@example.org", otp: "666666", type: "sign-in" });

			expect(fetchMock).not.toHaveBeenCalled();
			expect(errorMock).not.toHaveBeenCalled();
			expect(infoMock).toHaveBeenCalledWith(
				expect.objectContaining({ type: "sign-in", domain: "example.org" }),
				expect.stringContaining("suppressed")
			);
			// The suppression short-circuits before any rate-limit read or write — a domain that can
			// never receive mail has nothing worth tracking.
			expect(otpSourceSendAllowedMock).not.toHaveBeenCalled();
			expect(targetEmailSendAllowedMock).not.toHaveBeenCalled();
			expect(recordOtpSourceSendMock).not.toHaveBeenCalled();
			expect(recordTargetEmailSendMock).not.toHaveBeenCalled();
			// The OTP itself and the full address stay out of the log line — only the domain does.
			const everything = JSON.stringify(infoMock.mock.calls);
			expect(everything).not.toContain("666666");
			expect(everything).not.toContain("e2e-abc123@example.org");
		},
		120000
	);

	it(
		"codes to many new addresses stop at the site-wide ceiling while an existing account still gets its code (CUR-4172)",
		async () => {
			cfg.RESEND_API_KEY = "re_test_key";
			cfg.OTP_SITE_NEW_MAX_PER_DAY = "5";
			fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "r" }) });
			existingAccounts.add("member@school.test");
			const { sendVerificationOTP } = await import("./betterAuth");

			for (let i = 0; i < 8; i++) {
				await sendVerificationOTP({ email: `stranger-${i}@inbox.test`, otp: "111111", type: "sign-in" });
			}
			expect(fetchMock).toHaveBeenCalledTimes(5);
			expect(tripMock).toHaveBeenCalledTimes(3);

			await sendVerificationOTP({ email: "member@school.test", otp: "222222", type: "sign-in" });
			expect(fetchMock).toHaveBeenCalledTimes(6);
		},
		120000
	);

	it(
		"one address gets at most its daily allowance of codes, however the requests are spaced (CUR-4172)",
		async () => {
			cfg.RESEND_API_KEY = "re_test_key";
			cfg.CONTRIBUTION_IP_PEPPER = "test-pepper";
			cfg.OTP_ADDRESS_MAX_PER_DAY = "2";
			fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "r" }) });
			const { sendVerificationOTP } = await import("./betterAuth");

			// Under the 3-per-10-minute cap, so only the daily one can refuse the third.
			for (let i = 0; i < 3; i++) {
				await sendVerificationOTP({ email: "daily@inbox.test", otp: "333333", type: "sign-in" });
			}
			expect(fetchMock).toHaveBeenCalledTimes(2);
		},
		120000
	);

	it(
		"a member's own address is never daily-capped, so nobody who knows it can lock them out for a day (CUR-4172)",
		async () => {
			cfg.RESEND_API_KEY = "re_test_key";
			cfg.CONTRIBUTION_IP_PEPPER = "test-pepper";
			cfg.OTP_ADDRESS_MAX_PER_DAY = "2";
			fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "r" }) });
			existingAccounts.add("known-member@school.test");
			const { sendVerificationOTP } = await import("./betterAuth");

			for (let i = 0; i < 3; i++) {
				await sendVerificationOTP({ email: "known-member@school.test", otp: "444444", type: "sign-in" });
			}
			expect(fetchMock).toHaveBeenCalledTimes(3);
		},
		120000
	);

	it(
		"is case-insensitive on the reserved-domain match",
		async () => {
			cfg.RESEND_API_KEY = "re_test_key";
			const { sendVerificationOTP } = await import("./betterAuth");

			await sendVerificationOTP({ email: "e2e-xyz@EXAMPLE.ORG", otp: "777777", type: "sign-in" });

			expect(fetchMock).not.toHaveBeenCalled();
			expect(infoMock).toHaveBeenCalledWith(
				expect.objectContaining({ domain: "example.org" }),
				expect.stringContaining("suppressed")
			);
		},
		120000
	);
});
