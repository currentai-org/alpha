import { describe, expect, it } from "vitest";
import { isMintedGuestToken, mintGuestToken } from "./guestSession";

const SECRET = "test-secret-not-a-real-one";

describe("guest session tokens (CUR-3191)", () => {
	it("accepts a value it minted under the same secret", () => {
		expect(isMintedGuestToken(mintGuestToken(SECRET), SECRET)).toBe(true);
	});

	it("mints a different value every time", () => {
		expect(mintGuestToken(SECRET)).not.toBe(mintGuestToken(SECRET));
	});

	it("refuses a made-up value, including a bare uuid of the shape the old cookie had", () => {
		expect(isMintedGuestToken("11111111-2222-3333-4444-555555555555", SECRET)).toBe(false);
		expect(isMintedGuestToken("anything", SECRET)).toBe(false);
		expect(isMintedGuestToken("", SECRET)).toBe(false);
		expect(isMintedGuestToken(".", SECRET)).toBe(false);
		expect(isMintedGuestToken("abc.", SECRET)).toBe(false);
	});

	it("refuses a minted id carrying another id's signature", () => {
		const [, sig] = mintGuestToken(SECRET).split(".");
		const [otherId] = mintGuestToken(SECRET).split(".");
		expect(isMintedGuestToken(`${otherId}.${sig}`, SECRET)).toBe(false);
	});

	it("refuses a value minted under another secret", () => {
		expect(isMintedGuestToken(mintGuestToken("some-other-secret"), SECRET)).toBe(false);
	});

	it("refuses a truncated signature rather than comparing a prefix", () => {
		const token = mintGuestToken(SECRET);
		expect(isMintedGuestToken(token.slice(0, -4), SECRET)).toBe(false);
	});
});
