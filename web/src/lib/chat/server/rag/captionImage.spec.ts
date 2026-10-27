import { describe, it, expect, vi, afterEach } from "vitest";
import { parseVisionJson, assembleImageText, pickVisionModel } from "./captionImage";
import { logger } from "$lib/chat/server/logger";

describe("pickVisionModel (CUR-2319)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("picks the first multimodal model without a warning", async () => {
		const warn = vi.spyOn(logger, "warn");
		const id = await pickVisionModel({
			models: [{ id: "text-only" }, { id: "sees", multimodal: true }],
			defaultModel: { id: "text-only" },
		});
		expect(id).toBe("sees");
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns, naming the model, when no registered model is multimodal and it falls back to the default", async () => {
		const warn = vi.spyOn(logger, "warn");
		const id = await pickVisionModel({ models: [{ id: "text-only" }], defaultModel: { id: "text-only" } });
		expect(id).toBe("text-only");
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ visionModelFallback: true, servedModel: "text-only" }),
			expect.any(String)
		);
	});
});

describe("parseVisionJson", () => {
	it("parses a fenced JSON object", () => {
		const r = parseVisionJson('```json\n{"ocr_text":"X","description":"d","tags":["a","b"]}\n```');
		expect(r).toEqual({ ocr_text: "X", description: "d", tags: ["a", "b"] });
	});

	it("parses a bare object surrounded by prose", () => {
		const r = parseVisionJson('Here: {"ocr_text":"","description":"hi","tags":[]} done');
		expect(r.description).toBe("hi");
	});

	it("falls back to treating non-JSON output as the description", () => {
		const r = parseVisionJson("just a sentence");
		expect(r.description).toBe("just a sentence");
		expect(r.ocr_text).toBe("");
		expect(r.tags).toEqual([]);
	});

	it("coerces non-string tags and tolerates missing fields", () => {
		const r = parseVisionJson('{"tags":[1,"x"," y "]}');
		expect(r.tags).toEqual(["1", "x", "y"]);
		expect(r.ocr_text).toBe("");
		expect(r.description).toBe("");
	});

	it("returns empty fields for empty input", () => {
		expect(parseVisionJson("")).toEqual({ ocr_text: "", description: "", tags: [] });
	});
});

describe("assembleImageText", () => {
	it("orders OCR, description, then tags", () => {
		expect(assembleImageText({ ocr_text: "O", description: "D", tags: ["t1", "t2"] })).toBe(
			"O\n\nD\n\nTags: t1, t2"
		);
	});

	it("omits blank sections", () => {
		expect(assembleImageText({ ocr_text: "", description: "D", tags: [] })).toBe("D");
		expect(assembleImageText({ ocr_text: "", description: "", tags: [] })).toBe("");
	});
});
