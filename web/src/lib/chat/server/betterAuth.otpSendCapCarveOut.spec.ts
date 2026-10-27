/**
 * otpSendCapCarveOut is the only thing that can make Better Auth's built-in 3-per-60s
 * email-otp rate limit skip a single request. Every case here is really one assertion repeated —
 * that ALL THREE conditions must hold simultaneously, and any one missing echoes `currentRule`
 * back unchanged (Better Auth's customRules signature is `false | Rule`, no `undefined` — echoing
 * the rule it already resolved is the typed equivalent of "apply the real limit"), never `false`.
 * The Injury case from the ticket ("send four OTPs inside a minute without the header — the fourth
 * must still be refused") is the "missing header" test below; the others are the same shape for
 * the other two conditions plus the two ways "non-production" itself can be gotten wrong. (CUR-1553)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

const CURRENT_RULE = { window: 60, max: 3 };

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	cfg.E2E_OTP_BYPASS_TOKEN = "test-secret-value";
	delete process.env.VERCEL_ENV;
	delete process.env.DEPLOY_ENV;
});

async function importSubject() {
	const { otpSendCapCarveOut } = await import("./betterAuth");
	return (req: Request) => otpSendCapCarveOut(req, CURRENT_RULE);
}

function req({
	header,
	email = "e2e-abc123@example.org",
}: {
	header?: string;
	email?: string | undefined;
} = {}): Request {
	const headers = new Headers();
	if (header !== undefined) headers.set("x-e2e-otp-bypass", header);
	return new Request("https://example.vercel.app/api/auth/email-otp/send-verification-otp", {
		method: "POST",
		headers,
		body: JSON.stringify(email === undefined ? {} : { email }),
	});
}

describe("otpSendCapCarveOut (CUR-1553)", () => {
	it("bypasses the cap when all three conditions hold, on preview", async () => {
		process.env.VERCEL_ENV = "preview";
		const otpSendCapCarveOut = await importSubject();
		expect(await otpSendCapCarveOut(req({ header: "test-secret-value" }))).toBe(false);
	});

	it("bypasses the cap when all three conditions hold, on development", async () => {
		process.env.DEPLOY_ENV = "development";
		const otpSendCapCarveOut = await importSubject();
		expect(await otpSendCapCarveOut(req({ header: "test-secret-value" }))).toBe(false);
	});

	// The Injury case from the ticket: send four OTPs inside a minute without the header — the
	// fourth must still be refused. This is that refusal at the source: no header, no bypass.
	it("does NOT bypass on preview with no header at all (the ticket's Injury case)", async () => {
		process.env.VERCEL_ENV = "preview";
		const otpSendCapCarveOut = await importSubject();
		expect(await otpSendCapCarveOut(req())).toEqual(CURRENT_RULE);
	});

	it("does NOT bypass on preview with a wrong header value", async () => {
		process.env.VERCEL_ENV = "preview";
		const otpSendCapCarveOut = await importSubject();
		expect(await otpSendCapCarveOut(req({ header: "wrong-value" }))).toEqual(CURRENT_RULE);
	});

	it("does NOT bypass in production, even with a correct header and an example.org target", async () => {
		process.env.VERCEL_ENV = "production";
		const otpSendCapCarveOut = await importSubject();
		expect(await otpSendCapCarveOut(req({ header: "test-secret-value" }))).toEqual(CURRENT_RULE);
	});

	// deployEnv() null (neither DEPLOY_ENV nor VERCEL_ENV set) means the environment is undeclared or
	// misconfigured. This asserts the allow-list ("preview" or "development" only) over a deny-list
	// (`!== "production"`), which would wrongly treat null as safe to bypass.
	it("does NOT bypass when the environment is undeclared (deployEnv() returns null)", async () => {
		const otpSendCapCarveOut = await importSubject();
		expect(await otpSendCapCarveOut(req({ header: "test-secret-value" }))).toEqual(CURRENT_RULE);
	});

	it("does NOT bypass on preview, correct header, but a target outside example.org", async () => {
		process.env.VERCEL_ENV = "preview";
		const otpSendCapCarveOut = await importSubject();
		expect(
			await otpSendCapCarveOut(req({ header: "test-secret-value", email: "real-person@example.com" }))
		).toEqual(CURRENT_RULE);
	});

	it("does NOT bypass when E2E_OTP_BYPASS_TOKEN is unset, regardless of the header sent", async () => {
		process.env.VERCEL_ENV = "preview";
		delete cfg.E2E_OTP_BYPASS_TOKEN;
		const otpSendCapCarveOut = await importSubject();
		expect(await otpSendCapCarveOut(req({ header: "" }))).toEqual(CURRENT_RULE);
	});

	it("does NOT bypass and does NOT throw on a malformed/non-JSON body", async () => {
		process.env.VERCEL_ENV = "preview";
		const otpSendCapCarveOut = await importSubject();
		const malformed = new Request("https://example.vercel.app/api/auth/email-otp/send-verification-otp", {
			method: "POST",
			headers: { "x-e2e-otp-bypass": "test-secret-value" },
			body: "not json",
		});
		await expect(otpSendCapCarveOut(malformed)).resolves.toEqual(CURRENT_RULE);
	});

	it("never consumes the request body — the real route handler can still read it after", async () => {
		process.env.VERCEL_ENV = "preview";
		const otpSendCapCarveOut = await importSubject();
		const request = req({ header: "test-secret-value" });
		await otpSendCapCarveOut(request);
		await expect(request.json()).resolves.toEqual({ email: "e2e-abc123@example.org" });
	});
});
