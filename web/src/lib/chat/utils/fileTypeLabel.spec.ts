import { describe, expect, it } from "vitest";
import { DOCX_MIME } from "$lib/chat/constants/mime";
import { fileTypeLabel } from "./fileTypeLabel";

describe("fileTypeLabel (CUR-2839)", () => {
	it("names a PDF and a Word file in words, never by MIME type", () => {
		expect(fileTypeLabel("application/pdf", "policy.pdf")).toBe("PDF document");
		expect(fileTypeLabel(DOCX_MIME, "notes.docx")).toBe("Word document");
	});

	it("falls back to the extension, then to a generic word, and never returns the MIME type", () => {
		expect(fileTypeLabel("application/x-yaml", "config.yaml")).toBe("YAML file");
		expect(fileTypeLabel("application/octet-stream", "blob")).toBe("File");
		expect(fileTypeLabel("image/webp", "")).toBe("Image");
	});
});
