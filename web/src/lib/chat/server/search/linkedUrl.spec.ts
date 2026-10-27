import { describe, expect, it } from "vitest";
import { extractLinkedUrl, linkedPageNote } from "./linkedUrl";

describe("extractLinkedUrl — only a public web URL the person typed is fetchable (CUR-1897)", () => {
	it("finds the article link in a summarise request, without trailing punctuation", () => {
		expect(extractLinkedUrl("Est-ce que tu peux me résumer cet article? https://example.org/insights/an-essay.")).toBe(
			"https://example.org/insights/an-essay"
		);
		expect(extractLinkedUrl("(see https://example.org/a)")).toBe("https://example.org/a");
	});

	it("takes only the first URL, so one message costs at most one fetch", () => {
		expect(extractLinkedUrl("compare https://a.example/x and https://b.example/y")).toBe("https://a.example/x");
	});

	it("returns nothing for a message with no web URL", () => {
		expect(extractLinkedUrl("how do airlines price seats?")).toBeUndefined();
		expect(extractLinkedUrl("ftp://files.example.org/a")).toBeUndefined();
	});

	it("refuses raw IP addresses, including the cloud metadata address and a bare integer form", () => {
		for (const u of [
			"http://169.254.169.254/latest/meta-data",
			"http://10.0.0.5/admin",
			"http://2130706433/",
			"http://[::1]/",
		]) {
			expect(extractLinkedUrl(`summarise ${u}`)).toBeUndefined();
		}
	});

	it("refuses localhost and internal-looking hosts", () => {
		for (const u of ["http://localhost:5173/x", "https://db.internal/x", "http://printer.local/", "http://intranet/"]) {
			expect(extractLinkedUrl(u)).toBeUndefined();
		}
	});

	it("refuses embedded credentials and non-web ports", () => {
		expect(extractLinkedUrl("https://user:pw@example.org/")).toBeUndefined();
		expect(extractLinkedUrl("https://example.org:8443/")).toBeUndefined();
		expect(extractLinkedUrl("https://example.org:443/ok")).toBe("https://example.org/ok");
	});
});

// After one "I can't open links" reply, a turn with the page already fetched and grounded as
// source [1] still asked for the text to be pasted. The note has to name the source and retire the
// earlier refusal, and neither fallback state may tell the model links can never be opened. (CUR-2032)
describe("linkedPageNote", () => {
	it("names the source number the page was grounded as and retires an earlier refusal", () => {
		const note = linkedPageNote({ kind: "read", n: 3 });
		expect(note).toContain("source [3]");
		expect(note).toMatch(/earlier reply .* no longer applies/i);
	});

	it("says why the link was not opened when search is off, and names the control that opens it", () => {
		const note = linkedPageNote({ kind: "search-off" });
		expect(note).toMatch(/web search is off/i);
		expect(note).toContain('"Web search" control');
	});

	it("never lets the model claim it can never open links when the page was not read", () => {
		for (const kind of ["search-off", "unreadable"] as const) {
			expect(linkedPageNote({ kind })).toMatch(/do not say you can never open links/i);
		}
	});
});
