import { describe, expect, it } from "vitest";
import { commentResidueReason } from "./commentResidue";

// The shape a Google Docs export with comments produces, with made-up names (CUR-2634).
const DOCS_EXPORT_TAIL =
	"[a]I think these policies came from a partner's draft. One total reaction Sam reacted with 👍 " +
	"[b]Added a disclosure line. @alex@example.org a topic for our next call. [c]like what?";

describe("commentResidueReason (CUR-2634)", () => {
	it("refuses text ending in Docs comment threads, naming the fix", () => {
		expect(commentResidueReason(`Trust & Safety\n\nOur policies apply to every chat.\n\n${DOCS_EXPORT_TAIL}`)).toMatch(
			/Google Docs comment threads .* Export the document without comments/
		);
	});

	it("refuses an @-mention of an email address even with the markers stripped", () => {
		expect(commentResidueReason("Please review, @alex@example.org, before Friday.")).toMatch(/@-mention/);
	});

	it("allows a plain contact address, which a public policy page can carry", () => {
		expect(commentResidueReason("Report a problem to safety@example.org and we reply within a week.")).toBeUndefined();
	});

	it("allows a single bracketed letter, which ordinary text uses for lists", () => {
		expect(commentResidueReason("Option [a] is the default; see the table below.")).toBeUndefined();
	});
});
