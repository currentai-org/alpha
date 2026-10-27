import { describe, it, expect } from "vitest";
import { unreadFilesNotice } from "./unreadFilesNotice";

describe("unreadFilesNotice (CUR-3291)", () => {
	it("says nothing when every file was read", () => {
		expect(unreadFilesNotice([])).toBeUndefined();
	});

	it("names a file the bucket could not read and says asking again can work", () => {
		expect(unreadFilesNotice([{ name: "minutes.pdf", reason: "unreadable" }])).toBe(
			`Couldn't read "minutes.pdf" from storage just now, so this answer doesn't use it. Send your message again to retry.`
		);
	});

	it("names a missing file without promising a retry helps", () => {
		expect(unreadFilesNotice([{ name: "a.txt", reason: "missing" }, { name: "b.txt", reason: "missing" }])).toBe(
			`Couldn't find "a.txt", "b.txt", so this answer doesn't use them.`
		);
	});
});
