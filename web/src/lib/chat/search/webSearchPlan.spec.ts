import { describe, expect, it } from "vitest";
import { webSearchPlan } from "./webSearchPlan";

// The community-first decision matrix: webSearchMode × whether community/RAG already covered the turn.
// "skip" = no web; "run" = web unconditionally (always); "auto-gate" = consult the margin gate.
describe("webSearchPlan — community-first web decision", () => {
	it("off → never searches the web, regardless of community coverage", () => {
		expect(webSearchPlan({ mode: "off", communitySufficient: true })).toBe("skip");
		expect(webSearchPlan({ mode: "off", communitySufficient: false })).toBe("skip");
	});

	it("always → searches the web unconditionally (explicit user choice, skips the margin gate)", () => {
		expect(webSearchPlan({ mode: "always", communitySufficient: true })).toBe("run");
		expect(webSearchPlan({ mode: "always", communitySufficient: false })).toBe("run");
	});

	it("auto + community SUFFICIENT → skips the web (community-first: community wins)", () => {
		expect(webSearchPlan({ mode: "auto", communitySufficient: true })).toBe("skip");
	});

	it("auto + community INSUFFICIENT → consults the margin gate (web as fallback)", () => {
		expect(webSearchPlan({ mode: "auto", communitySufficient: false })).toBe("auto-gate");
	});

	it("auto + community SUFFICIENT but RECENCY query → still consults the gate (web augments the catalog)", () => {
		// The static catalog can't hold "latest developments" — a recency turn must reach the web even
		// when community had hits. Without recencyHint it would (wrongly) skip; the hint reopens the gate.
		expect(webSearchPlan({ mode: "auto", communitySufficient: true, recencyHint: true })).toBe(
			"auto-gate"
		);
	});

	it("auto + community SUFFICIENT + NON-recency → keeps the fast community-first skip (no extra gate)", () => {
		expect(webSearchPlan({ mode: "auto", communitySufficient: true, recencyHint: false })).toBe(
			"skip"
		);
	});

	it("recencyHint never overrides an explicit off/always choice", () => {
		expect(webSearchPlan({ mode: "off", communitySufficient: false, recencyHint: true })).toBe(
			"skip"
		);
		expect(webSearchPlan({ mode: "always", communitySufficient: true, recencyHint: false })).toBe(
			"run"
		);
	});

	it("undefined mode defaults to off (older clients / missing field)", () => {
		expect(webSearchPlan({ mode: undefined, communitySufficient: true })).toBe("skip");
		expect(webSearchPlan({ mode: undefined, communitySufficient: false })).toBe("skip");
	});

	it("unservableLive → skip, OVERRIDING manual always (never pretend-search live data)", () => {
		// A live scores/prices/weather ask can't be served by the open engines; even an explicit "always"
		// must not force a pretend-search that would stamp the turn grounded on a stale page.
		expect(
			webSearchPlan({ mode: "always", communitySufficient: false, unservableLive: true })
		).toBe("skip");
		expect(webSearchPlan({ mode: "auto", communitySufficient: false, unservableLive: true })).toBe(
			"skip"
		);
	});

	it("off still wins over unservableLive (user opted out of the web entirely)", () => {
		expect(webSearchPlan({ mode: "off", communitySufficient: false, unservableLive: true })).toBe(
			"skip"
		);
	});

	it("unservableLive:false leaves the normal matrix unchanged", () => {
		expect(
			webSearchPlan({ mode: "always", communitySufficient: true, unservableLive: false })
		).toBe("run");
		expect(webSearchPlan({ mode: "auto", communitySufficient: false, unservableLive: false })).toBe(
			"auto-gate"
		);
	});
});
