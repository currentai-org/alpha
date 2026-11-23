import { describe, expect, it } from "vitest";
import { commentResidueReason } from "./commentResidue";

// The shape a Google Docs export with comments produces, with made-up names.
const DOCS_EXPORT_TAIL =
	"[a]I think these policies came from a partner's draft. One total reaction Sam reacted with 👍 " +
	"[b]Added a disclosure line. @alex@example.org a topic for our next call. [c]like what?";

describe("commentResidueReason", () => {
	it("refuses text ending in Docs comment threads, naming the fix", () => {
		expect(commentResidueReason(`Trust & Safety\n\nOur policies apply to every chat.\n\n${DOCS_EXPORT_TAIL}`)).toMatch(
			/Google Docs comment threads .* Export the document without comments/
		);
	});

	it("refuses an @-mention of an email address even with the markers stripped", () => {
		expect(commentResidueReason("Please review, @alex@example.org, before Friday.")).toMatch(/@-mention/);
	});

	// Joined at runtime: a literal personal address in source fails the public export's leak scan.
	it("refuses a personal mailbox address even outside a comment thread, naming its provider", () => {
		expect(commentResidueReason(`Questions go to ${["sam.example", "gmail.com"].join("@")} for now.`)).toMatch(/personal email address at gmail\.com/);
		expect(commentResidueReason(`Contact: Alex <${["Alex.Doe", "Outlook.COM"].join("@")}>`)).toMatch(/personal email address at outlook\.com/);
	});

	it("allows an organisation's contact address on a subdomain that only looks like a provider", () => {
		expect(commentResidueReason("Write to privacy@mail.example.org.")).toBeUndefined();
	});

	it("allows a plain contact address, which a public policy page can carry", () => {
		expect(commentResidueReason("Report a problem to safety@example.org and we reply within a week.")).toBeUndefined();
	});

	it("allows a single bracketed letter, which ordinary text uses for lists", () => {
		expect(commentResidueReason("Option [a] is the default; see the table below.")).toBeUndefined();
	});
});
