import { describe, it, expect, vi } from "vitest";
import { queryLanguageMismatch, rewriteQueryNote } from "./queryLanguage";

const reads = (tag: string | undefined) => vi.fn(async () => tag);

describe("only a query in a different non-English language from the person's is sent back (CUR-4376)", () => {
	it("returns the person's language for a Spanish query on a Catalan message", async () => {
		expect(await queryLanguageMismatch("cat", "diseñador", reads("spa"))).toBe("cat");
	});
	it("lets the same language through, comparing base tags", async () => {
		expect(await queryLanguageMismatch("cat", "dissenyador", reads("cat"))).toBeUndefined();
		expect(await queryLanguageMismatch("por-BR", "designer", reads("por"))).toBeUndefined();
	});
	it("lets an English query through on a non-English message", async () => {
		expect(await queryLanguageMismatch("cat", "Park Güell designer", reads("eng"))).toBeUndefined();
	});
	it("lets an unreadable query through rather than guessing", async () => {
		expect(await queryLanguageMismatch("cat", "Park Güell", reads(undefined))).toBeUndefined();
	});
	it("never reads the query when the person wrote in English or no language is set", async () => {
		const read = reads("spa");
		expect(await queryLanguageMismatch("eng", "diseñador", read)).toBeUndefined();
		expect(await queryLanguageMismatch(undefined, "diseñador", read)).toBeUndefined();
		expect(read).not.toHaveBeenCalled();
	});
	it("names the language in English in the note", () => {
		expect(rewriteQueryNote("cat")).toContain("written in Catalan");
	});
});
