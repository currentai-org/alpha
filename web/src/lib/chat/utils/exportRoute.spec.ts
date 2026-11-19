import { describe, expect, it } from "vitest";
import { exportRoute, summaryState } from "./exportRoute";

// No account-page download takes the plain link until the summary has said nothing is sealed:
// the plain link's file holds sealed chats with their words missing, a loss nobody would notice.
describe("exportRoute", () => {
	it("never takes the plain link while the summary is still loading: it waits", () => {
		expect(exportRoute({ status: "loading" })).toBe("wait");
	});

	it("refuses, never takes the plain link, when the summary failed", () => {
		expect(exportRoute({ status: "failed" })).toBe("refuse");
	});

	it("builds in the browser when any chat is sealed, and takes the plain link only when none is", () => {
		expect(exportRoute({ status: "loaded", sealed: 2 })).toBe("browser");
		expect(exportRoute({ status: "loaded", sealed: 0 })).toBe("plain");
	});
});

describe("summaryState", () => {
	it("reads a whole sealed count, and treats a missing or malformed one as a failed summary, not as none", () => {
		expect(summaryState({ conversations: 3, sealed: 1 })).toEqual({ status: "loaded", sealed: 1 });
		expect(summaryState({ conversations: 3, sealed: 0 })).toEqual({ status: "loaded", sealed: 0 });
		expect(summaryState({ conversations: 3 })).toEqual({ status: "failed" });
		expect(summaryState({ sealed: -1 })).toEqual({ status: "failed" });
		expect(summaryState(null)).toEqual({ status: "failed" });
	});
});
