import { describe, expect, it } from "vitest";
import { isRetryable, failureMessage, type SecondOpinionFailure } from "./secondOpinionFailure";

describe("second-opinion failure handling", () => {
	// The whole point of the split. Named for the wrong behaviour it forbids, not for the branch it
	// exercises — "returns false for not_configured" would still pass if the copy went back to
	// inviting a retry, and the copy is half of what the user acts on.
	it("does NOT offer a retry for not_configured — the panel is absent, not slow", () => {
		expect(isRetryable("not_configured")).toBe(false);
	});

	it("does NOT tell the user to try again in the not_configured copy either", () => {
		const msg = failureMessage("not_configured");
		expect(msg).not.toMatch(/right now|try again|temporarily|momentarily/i);
		// It has to say the quiet part, or hiding the button just looks like a missing feature.
		expect(msg).toMatch(/won't change it/i);
	});

	it.each<SecondOpinionFailure>(["empty", "error", null])(
		"still offers a retry for %s — those are transient and a retry can win",
		(reason) => {
			expect(isRetryable(reason)).toBe(true);
			expect(failureMessage(reason)).toMatch(/unavailable right now/i);
		}
	);

	// An unrecognised reason from a future server version must not silently become permanent —
	// that would strand the user with no way back for a cause we know nothing about.
	it("treats an unknown reason as retryable rather than permanent", () => {
		expect(isRetryable("panel_on_fire" as SecondOpinionFailure)).toBe(true);
	});
});
