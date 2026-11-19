import { describe, expect, it } from "vitest";
import { cleanTagName, normalizeTagNames, parseTagQuery, tagIdFor, TAG_NAME_MAX, TAGS_PER_CHAT_MAX } from "./chatTags";

describe("chat tag names and ids", () => {
	it("an id is the name lowercased with spaces as underscores, Open WebUI's rule", () => {
		expect(tagIdFor("Grant writing")).toBe("grant_writing");
		expect(tagIdFor("teaching")).toBe("teaching");
	});

	it("a typed name loses stray whitespace and is cut to the limit; blank or non-text is no name", () => {
		expect(cleanTagName("  Grant \n  writing ")).toBe("Grant writing");
		expect(cleanTagName("x".repeat(TAG_NAME_MAX + 5))).toHaveLength(TAG_NAME_MAX);
		expect(cleanTagName("   ")).toBeNull();
		expect(cleanTagName(3)).toBeNull();
	});

	it("a list keeps one tag per id, the first spelling, in order, and at most the per-chat limit", () => {
		expect(normalizeTagNames(["Grant", "grant", "", "Teaching"])).toEqual([
			{ id: "grant", name: "Grant" },
			{ id: "teaching", name: "Teaching" },
		]);
		const many = Array.from({ length: TAGS_PER_CHAT_MAX + 3 }, (_, i) => `t${i}`);
		expect(normalizeTagNames(many)).toHaveLength(TAGS_PER_CHAT_MAX);
	});

	it("a search query gives up its tag: terms as ids and keeps the other words", () => {
		expect(parseTagQuery("tag:Grant budget")).toEqual({ text: "budget", tags: ["grant"] });
		expect(parseTagQuery('notes tag:"teaching notes" tag:grant')).toEqual({ text: "notes", tags: ["teaching_notes", "grant"] });
		expect(parseTagQuery("TAG:grant tag:grant")).toEqual({ text: "", tags: ["grant"] });
		// "tag:" inside a word is not a tag term.
		expect(parseTagQuery("hashtag:fun")).toEqual({ text: "hashtag:fun", tags: [] });
		expect(parseTagQuery("plain words")).toEqual({ text: "plain words", tags: [] });
	});
});
