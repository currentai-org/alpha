import { describe, expect, it } from "vitest";
import { nextWebSearchMode, type WebSearchMode } from "./webSearchMode";
import { resolveInitialWebSearchMode } from "./webSearchModeDefault";

describe("nextWebSearchMode — composer cycle order", () => {
	it("cycles off → auto → always → off", () => {
		expect(nextWebSearchMode("off")).toBe("auto");
		expect(nextWebSearchMode("auto")).toBe("always");
		expect(nextWebSearchMode("always")).toBe("off");
	});

	it("is a closed cycle over exactly the three states", () => {
		const seen = new Set<WebSearchMode>();
		let m: WebSearchMode = "off";
		for (let i = 0; i < 3; i++) {
			seen.add(m);
			m = nextWebSearchMode(m);
		}
		expect([...seen].sort()).toEqual(["always", "auto", "off"]);
		expect(m).toBe("off"); // returned to start after 3 hops
	});
});

// Auto is the default. A stored "off" under the old key is a default the store once wrote on every
// load, not a choice. What a person picked at the control, or in the old boolean toggle, still stands.
describe("resolveInitialWebSearchMode — auto unless the person chose otherwise", () => {
	const from = (stored: Record<string, string>) => (k: string) => stored[k] ?? null;

	it("starts a new visitor on auto", () => {
		expect(resolveInitialWebSearchMode(from({}))).toBe("auto");
	});

	it("moves a visitor whose only record is the old written-back off to auto", () => {
		expect(resolveInitialWebSearchMode(from({ "ap:webSearchMode": "off" }))).toBe("auto");
	});

	it("keeps off for someone who chose it at the control", () => {
		expect(
			resolveInitialWebSearchMode(from({ "ap:webSearchChoice": "off", "ap:webSearchMode": "off" }))
		).toBe("off");
	});

	it("keeps off for someone who turned the old boolean toggle off", () => {
		expect(resolveInitialWebSearchMode(from({ "ap:webSearchAllowed": "0" }))).toBe("off");
	});

	it("keeps auto or always stored under the old key, since only a person could have picked them", () => {
		expect(resolveInitialWebSearchMode(from({ "ap:webSearchMode": "always" }))).toBe("always");
		expect(resolveInitialWebSearchMode(from({ "ap:webSearchMode": "auto" }))).toBe("auto");
	});
});
