import { describe, expect, it } from "vitest";
import { friendlyAuthErrorMessage, friendlyPasskeyError } from "./authErrorMessages";

describe("friendlyAuthErrorMessage", () => {
	it("explains a state_mismatch as an expired link, not a raw code", () => {
		const message = friendlyAuthErrorMessage("state_mismatch");
		expect(message).not.toContain("state_mismatch");
		expect(message.toLowerCase()).toContain("expired");
	});

	it("reads a cancelled consent (access_denied) as a cancellation, naming neither linking nor the raw code", () => {
		const message = friendlyAuthErrorMessage("access_denied");
		expect(message).not.toContain("access_denied");
		expect(message.toLowerCase()).not.toContain("link");
		expect(message.toLowerCase()).toContain("cancelled");
	});

	it("still names an unlisted code rather than dropping it silently", () => {
		expect(friendlyAuthErrorMessage("some_new_code")).toBe(
			"Linking failed (some_new_code). Try again in a moment."
		);
	});
});

describe("friendlyPasskeyError", () => {
	it("tells a visitor whose passkey ceremony failed to sign in another way, naming each offered method, never the bare 'Auth cancelled' (CUR-2924)", () => {
		for (const code of ["AUTH_CANCELLED", "ERROR_CEREMONY_ABORTED", "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY"]) {
			const message = friendlyPasskeyError({ code, message: "Auth cancelled" }, ["Google", "GitHub", "Hugging Face"]);
			expect(message).not.toMatch(/auth cancelled/i);
			expect(message).toBe(
				"No passkey was used. If this device doesn't have one for Alpha, sign in with email, Google, GitHub or Hugging Face below."
			);
		}
	});

	it("names only email when the deployment offers no other provider (CUR-2924)", () => {
		expect(friendlyPasskeyError({ code: "AUTH_CANCELLED" }, [])).toMatch(/sign in with email below\.$/);
	});

	it("keeps the server's own message for an options-request failure, which is not a ceremony failure", () => {
		expect(friendlyPasskeyError({ code: "TOO_MANY_REQUESTS", message: "Too many requests" }, ["Google"])).toBe(
			"Too many requests"
		);
	});
});
