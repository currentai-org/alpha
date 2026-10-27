import { describe, it, expect } from "vitest";
import { classifyByMime, classifyUpload, titleFromFilename, extensionOf } from "./ragUpload";

describe("classifyByMime", () => {
	it("classifies by mime only, ignoring any filename", () => {
		expect(classifyByMime("image/png")).toBe("image");
		expect(classifyByMime("application/pdf")).toBe("pdf");
		expect(
			classifyByMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
		).toBe("docx");
		expect(classifyByMime("text/csv")).toBe("csv");
		expect(classifyByMime("text/plain")).toBe("text");
	});

	it("returns null for unsupported, generic, or empty mimes", () => {
		expect(classifyByMime("application/x-msdownload")).toBeNull();
		expect(classifyByMime("application/zip")).toBeNull();
		expect(classifyByMime("")).toBeNull();
		expect(classifyByMime(undefined)).toBeNull();
	});
});

describe("classifyUpload", () => {
	it("detects images by mime and by extension", () => {
		expect(classifyUpload("x", "image/png")).toBe("image");
		expect(classifyUpload("photo.JPG", "")).toBe("image");
		expect(classifyUpload("a.webp", undefined)).toBe("image");
	});

	it("maps document/data extensions", () => {
		expect(classifyUpload("a.pdf", "")).toBe("pdf");
		expect(classifyUpload("a.docx", "")).toBe("docx");
		expect(classifyUpload("a.csv", "")).toBe("csv");
		expect(classifyUpload("a.tsv", "")).toBe("csv");
		expect(classifyUpload("a.jsonl", "")).toBe("json");
		expect(classifyUpload("a.md", "")).toBe("markdown");
		expect(classifyUpload("a.txt", "")).toBe("text");
		expect(classifyUpload("a.htm", "")).toBe("html");
	});

	it("falls back to the mime when the extension is unknown", () => {
		expect(classifyUpload("blob", "application/pdf")).toBe("pdf");
		expect(classifyUpload("blob", "text/plain")).toBe("text");
	});

	it("returns null for unsupported types", () => {
		expect(classifyUpload("a.exe", "application/octet-stream")).toBeNull();
		expect(classifyUpload("noext", undefined)).toBeNull();
	});
});

describe("titleFromFilename", () => {
	it("drops the extension and humanizes separators", () => {
		expect(titleFromFilename("annual_report.pdf")).toBe("annual report");
		expect(titleFromFilename("my.notes.final.md")).toBe("my notes final");
		expect(titleFromFilename("plain")).toBe("plain");
	});
});

describe("extensionOf", () => {
	it("returns the lowercased extension or empty", () => {
		expect(extensionOf("a.PDF")).toBe("pdf");
		expect(extensionOf("noext")).toBe("");
	});
});
