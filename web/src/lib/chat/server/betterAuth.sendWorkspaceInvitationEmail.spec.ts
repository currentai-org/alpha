/**
 * Same reason betterAuth.sendVerificationOTP.spec.ts exists standalone — this doesn't need a
 * live betterAuth() instance (buildAuth() eagerly calls getDb(), which throws without DATABASE_URL).
 *
 * Same 120000ms bump as that sibling file, same cause: the first dynamic `import("./betterAuth")` in
 * this file pulls in the whole module graph (better-auth, drizzle-adapter, etc.), which can exceed the
 * default 30s timeout on a loaded shared host, including under `git push`'s pre-push gate. (CUR-550)
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

const env = { dev: false };
vi.mock("$app/environment", () => ({
	get dev() {
		return env.dev;
	},
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// The per-inviting-user counter lives in its own module (real DB access,
// message_events) — mocked here the same way config/logger are, rather than exercised for real, since
// this whole file's premise is no live DB. (CUR-912)
const workspaceInviteState = { allowed: true };
// Mirrors the real function's own no-userId contract (always allowed when there's nothing to key on) —
// otherwise this mock would diverge from the thing it's standing in for.
const workspaceInviteAllowedMock = vi.fn(async (userId?: string) =>
	userId ? workspaceInviteState.allowed : true
);
const recordWorkspaceInviteSendMock = vi.fn(async () => {});
// The site-wide ceiling, same premise. (CUR-3194)
const siteInviteState = { allowed: true };
const siteInviteAllowedMock = vi.fn(async () => siteInviteState.allowed);
const recordSiteInviteSendMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/db/workspaceInviteRate", () => ({
	workspaceInviteAllowed: workspaceInviteAllowedMock,
	recordWorkspaceInviteSend: recordWorkspaceInviteSendMock,
	maxInvitesPerDay: () => 20,
	siteInviteAllowed: siteInviteAllowedMock,
	recordSiteInviteSend: recordSiteInviteSendMock,
}));

// Live pending invitations already held by the target address. (CUR-4167)
const pendingState = { count: 0 as number | null };
const pendingInvitationCountMock = vi.fn(async () => pendingState.count);
vi.mock("$lib/chat/server/pendingInvitations", () => ({ pendingInvitationCount: pendingInvitationCountMock }));

const captureMock = vi.fn();
vi.mock("$lib/chat/server/errorTracking", () => ({ captureServerException: captureMock }));

// The DB-backed target-email backstop, also real-DB-backed, also mocked here. Defaults to
// "always allowed" so it doesn't interfere with tests exercising the in-memory limiters it backstops. (CUR-920)
const targetEmailRateState = { allowed: true };
const targetEmailSendAllowedMock = vi.fn(async () => targetEmailRateState.allowed);
const recordTargetEmailSendMock = vi.fn(async () => {});
// sendVerificationOTP (exercised by one test below, alongside
// sendWorkspaceInvitationEmail, to prove the two limiters are independent) also calls the
// (ip, target) source-pair backstop — same "mock the whole module" premise, defaulting to allowed.
const otpSourceSendAllowedMock = vi.fn(async () => true);
const recordOtpSourceSendMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/db/targetEmailRate", () => ({
	targetEmailSendAllowed: targetEmailSendAllowedMock,
	recordTargetEmailSend: recordTargetEmailSendMock,
	otpSourceSendAllowed: otpSourceSendAllowedMock,
	recordOtpSourceSend: recordOtpSourceSendMock,
}));

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	env.dev = false;
	infoMock.mockReset();
	errorMock.mockReset();
	fetchMock.mockReset();
	workspaceInviteState.allowed = true;
	workspaceInviteAllowedMock.mockClear();
	recordWorkspaceInviteSendMock.mockClear();
	siteInviteState.allowed = true;
	pendingState.count = 0;
	siteInviteAllowedMock.mockClear();
	recordSiteInviteSendMock.mockClear();
	captureMock.mockReset();
	targetEmailRateState.allowed = true;
	targetEmailSendAllowedMock.mockClear();
	recordTargetEmailSendMock.mockClear();
	otpSourceSendAllowedMock.mockClear().mockResolvedValue(true);
	recordOtpSourceSendMock.mockClear();
});

describe("sendWorkspaceInvitationEmail (CUR-550)", () => {
	it("in dev, logs the stub (with the accept URL) and never calls fetch when RESEND_API_KEY is unset", async () => {
		env.dev = true;
		const { sendWorkspaceInvitationEmail } = await import("./betterAuth");
		await sendWorkspaceInvitationEmail({
			id: "inv-1",
			email: "a@example.com",
			organizationName: "Acme",
			inviterEmail: "admin@example.com",
			acceptUrl: "https://example.org/chat/workspace/accept/inv-1",
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(infoMock).toHaveBeenCalledWith(
			expect.objectContaining({ email: "a@example.com", id: "inv-1" }),
			expect.stringContaining("stub")
		);
	}, 120000);

	it("outside dev, an unset RESEND_API_KEY logs an error and leaks no invitee address", async () => {
		const { sendWorkspaceInvitationEmail } = await import("./betterAuth");
		await sendWorkspaceInvitationEmail({
			id: "inv-1",
			email: "a@example.com",
			organizationName: "Acme",
			inviterEmail: "admin@example.com",
			acceptUrl: "https://example.org/chat/workspace/accept/inv-1",
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(errorMock).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(errorMock.mock.calls)).not.toContain("a@example.com");
	}, 120000);

	// workspaces.spec.ts invites a fresh e2e-<uuid>@example.org on every run. A real send would
	// spend one of Resend's daily sends on an address with a null MX. (CUR-1930)
	it("never calls Resend or touches a rate limiter for an invite to the reserved example.org domain", async () => {
		cfg.RESEND_API_KEY = "re_test_key";
		const { sendWorkspaceInvitationEmail } = await import("./betterAuth");
		await sendWorkspaceInvitationEmail({
			id: "inv-1",
			email: "e2e-0000@Example.org",
			organizationName: "E2E Workspace",
			inviterEmail: "admin@example.com",
			acceptUrl: "https://example.org/chat/workspace/accept/inv-1",
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(recordTargetEmailSendMock).not.toHaveBeenCalled();
		expect(recordWorkspaceInviteSendMock).not.toHaveBeenCalled();
	}, 120000);

	it("POSTs to Resend with the accept link in the body and logs success when RESEND_API_KEY is set", async () => {
		cfg.RESEND_API_KEY = "re_test_key";
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "resend-id-1" }), { status: 200 })
		);
		const { sendWorkspaceInvitationEmail } = await import("./betterAuth");
		await sendWorkspaceInvitationEmail({
			id: "inv-1",
			email: "b@example.com",
			organizationName: "Acme",
			inviterEmail: "admin@example.com",
			acceptUrl: "https://example.org/chat/workspace/accept/inv-1",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.resend.com/emails");
		const body = JSON.parse(init.body as string);
		expect(body.to).toEqual(["b@example.com"]);
		expect(body.text).toContain("https://example.org/chat/workspace/accept/inv-1");

		expect(errorMock).not.toHaveBeenCalled();
		expect(infoMock).toHaveBeenCalledWith(
			expect.objectContaining({ resendId: "resend-id-1", invitationId: "inv-1" }),
			expect.stringContaining("sent")
		);
	}, 120000);

	it("logs the failure loudly (not thrown) when Resend returns a non-ok response", async () => {
		cfg.RESEND_API_KEY = "re_test_key";
		fetchMock.mockResolvedValueOnce(new Response("bad key", { status: 401 }));
		const { sendWorkspaceInvitationEmail } = await import("./betterAuth");
		await expect(
			sendWorkspaceInvitationEmail({
				id: "inv-1",
				email: "c@example.com",
				organizationName: "Acme",
				inviterEmail: "admin@example.com",
				acceptUrl: "https://example.org/chat/workspace/accept/inv-1",
			})
		).resolves.toBeUndefined();

		expect(errorMock).toHaveBeenCalledWith(
			expect.objectContaining({ status: 401 }),
			expect.stringContaining("Resend")
		);
	}, 120000);

	it("caps real sends per TARGET EMAIL, independently of the email-OTP limiter", async () => {
		cfg.RESEND_API_KEY = "re_test_key";
		fetchMock.mockImplementation(
			async () => new Response(JSON.stringify({ id: "resend-id-x" }), { status: 200 })
		);
		const { sendVerificationOTP, sendWorkspaceInvitationEmail } = await import("./betterAuth");
		const invite = () =>
			sendWorkspaceInvitationEmail({
				id: "inv-1",
				email: "d@example.com",
				organizationName: "Acme",
				inviterEmail: "admin@example.com",
				acceptUrl: "https://example.org/chat/workspace/accept/inv-1",
			});

		// The OTP limiter allows only 3 sends per address — exhaust it, then confirm the invitation
		// limiter (separate instance, higher cap) is untouched by that. example.com, not .org — the
		// latter is a reserved domain CUR-1254 short-circuits sendVerificationOTP for entirely, which
		// would defeat this test's premise of actually exhausting the limiter via real sends.
		await sendVerificationOTP({ email: "d@example.com", otp: "111111", type: "sign-in" });
		await sendVerificationOTP({ email: "d@example.com", otp: "111111", type: "sign-in" });
		await sendVerificationOTP({ email: "d@example.com", otp: "111111", type: "sign-in" });
		await sendVerificationOTP({ email: "d@example.com", otp: "111111", type: "sign-in" }); // OTP-limited
		fetchMock.mockClear();
		infoMock.mockClear();

		await invite();
		await invite();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(infoMock).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining("rate-limited")
		);
	}, 120000);

	it("blocks a send when the DB-backed target-email backstop reports the cap reached (CUR-920), independently of the in-memory limiter and the per-user counter", async () => {
		cfg.RESEND_API_KEY = "re_test_key";
		targetEmailRateState.allowed = false; // the in-memory limiter alone would allow this send
		const { sendWorkspaceInvitationEmail } = await import("./betterAuth");

		await sendWorkspaceInvitationEmail({
			id: "inv-5",
			email: "g@example.com",
			organizationName: "Acme",
			inviterEmail: "admin@example.com",
			acceptUrl: "https://example.org/chat/workspace/accept/inv-5",
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(infoMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining("rate-limited by target address (DB-backed)")
		);
		expect(recordTargetEmailSendMock).not.toHaveBeenCalled();
	}, 120000);

	// A stranger chooses the workspace name, so it must not lead the email, and the person
	// receiving it must be able to see who sent it. (CUR-3194)
	it("keeps the workspace name out of the subject and names the inviter in the body", async () => {
		cfg.RESEND_API_KEY = "re_test_key";
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "r" }), { status: 200 }));
		const { sendWorkspaceInvitationEmail } = await import("./betterAuth");
		await sendWorkspaceInvitationEmail({
			id: "inv-9",
			email: "h@example.com",
			organizationName: "Claim your prize now",
			inviterEmail: "sender@example.net",
			acceptUrl: "https://example.org/chat/workspace/accept/inv-9",
		});

		const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
		expect(body.subject).not.toContain("Claim your prize now");
		expect(body.text).toContain("sender@example.net invited you");
	}, 120000);
});

describe("refuseOverInviteCaps (CUR-2835, CUR-3194)", () => {
	it("refuses once the site-wide ceiling is reached, reports it, and records nothing", async () => {
		siteInviteState.allowed = false;
		const { refuseOverInviteCaps } = await import("./betterAuth");

		await expect(refuseOverInviteCaps({ id: "user-1" }, "x@example.com")).rejects.toMatchObject({
			body: { message: expect.stringContaining("as many workspace invitations as it can today") },
		});
		expect(captureMock).toHaveBeenCalledTimes(1);
		expect(recordWorkspaceInviteSendMock).not.toHaveBeenCalled();
		expect(recordSiteInviteSendMock).not.toHaveBeenCalled();
	}, 120000);

	it("an inviter over their own cap is refused without spending a site-wide slot", async () => {
		workspaceInviteState.allowed = false;
		const { refuseOverInviteCaps } = await import("./betterAuth");

		await expect(refuseOverInviteCaps({ id: "user-1" }, "x@example.com")).rejects.toMatchObject({
			body: { message: expect.stringContaining("20 invitations a day") },
		});
		expect(siteInviteAllowedMock).not.toHaveBeenCalled();
		expect(recordSiteInviteSendMock).not.toHaveBeenCalled();
	}, 120000);

	it("under both caps, allows the invite and counts it against both", async () => {
		const { refuseOverInviteCaps } = await import("./betterAuth");

		await expect(refuseOverInviteCaps({ id: "user-1" }, "x@example.com")).resolves.toBeUndefined();
		expect(recordWorkspaceInviteSendMock).toHaveBeenCalledWith("user-1");
		expect(recordSiteInviteSendMock).toHaveBeenCalledTimes(1);
	}, 120000);

	it("an address holding 5 pending invites refuses a 6th, the reserved test domain included (CUR-4167)", async () => {
		const { refuseOverInviteCaps } = await import("./betterAuth");
		pendingState.count = 4;
		await expect(refuseOverInviteCaps({ id: "user-1" }, "e2e-1@example.org")).resolves.toBeUndefined();
		for (const email of ["x@example.com", "e2e-1@example.org"]) {
			pendingState.count = 5;
			recordWorkspaceInviteSendMock.mockClear();
			await expect(refuseOverInviteCaps({ id: "user-1" }, email)).rejects.toMatchObject({
				body: { message: expect.stringContaining("can't take more workspace invitations") },
			});
			expect(pendingInvitationCountMock).toHaveBeenLastCalledWith(email);
			expect(recordWorkspaceInviteSendMock).not.toHaveBeenCalled();
		}
	}, 120000);

	it("a failed pending-invite count lets the invite through, like every other cap here", async () => {
		pendingState.count = null;
		const { refuseOverInviteCaps } = await import("./betterAuth");
		await expect(refuseOverInviteCaps({ id: "user-1" }, "x@example.com")).resolves.toBeUndefined();
	}, 120000);

	it("an invite to the reserved test domain never touches the site-wide ceiling", async () => {
		siteInviteState.allowed = false;
		const { refuseOverInviteCaps } = await import("./betterAuth");

		await expect(refuseOverInviteCaps({ id: "user-1" }, "e2e-1@example.org")).resolves.toBeUndefined();
		expect(siteInviteAllowedMock).not.toHaveBeenCalled();
		expect(recordSiteInviteSendMock).not.toHaveBeenCalled();
		expect(recordWorkspaceInviteSendMock).toHaveBeenCalledWith("user-1");
	}, 120000);
});
