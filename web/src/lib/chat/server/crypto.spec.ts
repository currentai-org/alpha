import { describe, expect, it } from "vitest";
import { secretEquals } from "./crypto";

describe("secretEquals (CUR-3524)", () => {
	const secret = "s3cret-value";

	it("accepts the exact secret", () => {
		expect(secretEquals(secret, secret)).toBe(true);
	});

	it("refuses a prefix, an extension, and a same-length value with a wrong last character", () => {
		expect(secretEquals(secret.slice(0, -1), secret)).toBe(false);
		expect(secretEquals(`${secret}x`, secret)).toBe(false);
		expect(secretEquals(`${secret.slice(0, -1)}X`, secret)).toBe(false);
	});

	it("refuses a missing or empty value rather than treating it as a match", () => {
		expect(secretEquals(null, secret)).toBe(false);
		expect(secretEquals(undefined, secret)).toBe(false);
		expect(secretEquals("", secret)).toBe(false);
	});
});
