import { describe, expect, it } from "vitest";

import { viewportNote } from "../journeyGallery";

// CUR-1554 is a reminder to turn mobile recording back on once A1–A4 and A8 are polished on
// desktop, and this sentence is the only thing that will deliver it. Mobile is off by default now
// (playwright.config.ts gates the project on JOURNEY_MOBILE_VIEWPORT), so the page shows no mobile
// cards — and no mobile cards is exactly what "mobile ran and recorded nothing" looks like too.
// The run states what it was CONFIGURED for and this turns that into the line a reviewer reads first.
describe("the viewport clause of the configuration line", () => {
	it("says mobile recording is off when the run configured desktop only", () => {
		expect(viewportNote(["desktop"])).toBe("desktop only — mobile recording is off");
	});

	it("names both viewports once mobile is back on, so the reminder disappears by itself", () => {
		expect(viewportNote(["desktop", "mobile"])).toBe("desktop and mobile");
	});

	// A manifest published before the field existed knows nothing about viewports. Saying
	// "desktop only" there would print a guess in the same sentence as measured configuration.
	it("says nothing at all for a manifest that predates the field, rather than guessing", () => {
		expect(viewportNote(undefined)).toBe("");
	});
});
