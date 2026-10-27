/**
 * Everyone behind one venue IP shares Better Auth's per-IP sign-in cap, so production's
 * rule must allow far more than the built-in 3 per window, keep each window, and leave the preview
 * test carve-out (returns false) working. (CUR-4594)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

beforeEach(() => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	cfg.E2E_OTP_BYPASS_TOKEN = "test-secret-value";
	delete process.env.VERCEL_ENV;
	delete process.env.DEPLOY_ENV;
});

function req(header?: string): Request {
	const headers = new Headers();
	if (header !== undefined) headers.set("x-e2e-otp-bypass", header);
	return new Request("https://example.vercel.app/api/auth/sign-in/email-otp", {
		method: "POST",
		headers,
		body: JSON.stringify({ email: "e2e-abc123@example.org" }),
	});
}

describe("venueSignInRule (CUR-4594)", () => {
	it("raises the 10 s sign-in max well above the built-in 3 per IP in production, keeping the window", async () => {
		process.env.VERCEL_ENV = "production";
		const { venueSignInRule, SIGN_IN_SHARED_IP_MULTIPLIER } = await import("./betterAuth");
		const rule = await venueSignInRule(req(), { window: 10, max: 3 });
		expect(rule).toEqual({ window: 10, max: 3 * SIGN_IN_SHARED_IP_MULTIPLIER });
		expect(SIGN_IN_SHARED_IP_MULTIPLIER).toBeGreaterThanOrEqual(10);
	});

	it("raises the 60 s email-code send max too, keeping the window", async () => {
		process.env.VERCEL_ENV = "production";
		const { venueSignInRule, SIGN_IN_SHARED_IP_MULTIPLIER } = await import("./betterAuth");
		expect(await venueSignInRule(req(), { window: 60, max: 3 })).toEqual({
			window: 60,
			max: 3 * SIGN_IN_SHARED_IP_MULTIPLIER,
		});
	});

	it("still skips the limit entirely for the preview test carve-out", async () => {
		process.env.VERCEL_ENV = "preview";
		const { venueSignInRule } = await import("./betterAuth");
		expect(await venueSignInRule(req("test-secret-value"), { window: 10, max: 3 })).toBe(false);
	});
});
