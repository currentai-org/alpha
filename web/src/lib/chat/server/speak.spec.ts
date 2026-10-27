import { describe, expect, it } from "vitest";
import { resolveSpeakMode } from "./speak";

describe("resolveSpeakMode — effective per-turn speak preference", () => {
	it("uses speakMode verbatim when the client sent it (the authoritative tri-state)", () => {
		expect(resolveSpeakMode("off", undefined)).toBe("off");
		expect(resolveSpeakMode("auto", undefined)).toBe("auto");
		expect(resolveSpeakMode("always", undefined)).toBe("always");
	});

	it("lets a present speakMode:'off' WIN over a contradictory legacy speakAll:true (deploy-skew safety)", () => {
		// The load-bearing case: a stale/crafted payload with off + speakAll:true must resolve to off,
		// so the server never synthesizes when the user chose off.
		expect(resolveSpeakMode("off", true)).toBe("off");
	});

	it("also honors speakMode:'auto'/'always' regardless of the legacy boolean", () => {
		expect(resolveSpeakMode("auto", true)).toBe("auto");
		expect(resolveSpeakMode("always", false)).toBe("always");
	});

	it("falls back to the legacy boolean ONLY for an old client (speakMode absent): true → always", () => {
		expect(resolveSpeakMode(undefined, true)).toBe("always");
	});

	it("old client without speakAll (or speakAll:false) → the D3 default 'auto'", () => {
		expect(resolveSpeakMode(undefined, false)).toBe("auto");
		expect(resolveSpeakMode(undefined, undefined)).toBe("auto");
	});
});
