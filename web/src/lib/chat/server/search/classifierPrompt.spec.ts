import { describe, it, expect } from "vitest";
import { attachmentNote } from "./classifierPrompt";

describe("attachmentNote (CUR-3192)", () => {
	it("is undefined with nothing attached, so a plain turn's prompt is unchanged", () => {
		expect(attachmentNote([])).toBeUndefined();
	});

	it("counts each kind, in the order they first appear", () => {
		expect(attachmentNote(["image"])).toBe("Attached to the message: 1 image.");
		expect(attachmentNote(["image", "document", "image"])).toBe(
			"Attached to the message: 2 images, 1 document."
		);
		expect(attachmentNote(["pasted text", "pasted text"])).toBe("Attached to the message: 2 pasted texts.");
	});
});
