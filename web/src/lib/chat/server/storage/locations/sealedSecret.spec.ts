import { describe, expect, it } from "vitest";
import { open, seal, SealedSecretError } from "./sealedSecret";

const SECRET = "test-secret-not-a-real-one";

describe("sealedSecret", () => {
	it("round-trips a credential under the same secret", () => {
		expect(open(seal("hf_example_token", SECRET), SECRET)).toBe("hf_example_token");
	});

	it("never stores the plaintext inside the sealed value", () => {
		expect(seal("hf_example_token", SECRET)).not.toContain("hf_example_token");
	});

	it("seals the same plaintext differently each time (fresh nonce)", () => {
		expect(seal("x", SECRET)).not.toBe(seal("x", SECRET));
	});

	it("refuses (throws, never returns garbage) a value whose ciphertext was altered", () => {
		const sealed = seal("hf_example_token", SECRET);
		const raw = Buffer.from(sealed.slice(3), "base64url");
		raw[14] ^= 1;
		expect(() => open(`v1.${raw.toString("base64url")}`, SECRET)).toThrow(SealedSecretError);
	});

	it("refuses a value sealed under a different secret, which is what rotating BETTER_AUTH_SECRET does", () => {
		expect(() => open(seal("hf_example_token", SECRET), "another-secret")).toThrow(SealedSecretError);
	});

	it("refuses an unversioned or truncated value", () => {
		expect(() => open("hf_example_token", SECRET)).toThrow(SealedSecretError);
		expect(() => open("v1.AAAA", SECRET)).toThrow(SealedSecretError);
	});
});
