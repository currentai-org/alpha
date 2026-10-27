import { describe, expect, it } from "vitest";
import {
	assertUnderPrefix,
	normalizePrefix,
	parseBucketRepo,
	PathOutsideLocationError,
	resolveUnderPrefix,
} from "./hfBucketLocation";

describe("parseBucketRepo", () => {
	it("accepts the forms a person pastes: name/bucket, buckets/name/bucket, and the hf.co URL", () => {
		expect(parseBucketRepo("me/files")).toBe("buckets/me/files");
		expect(parseBucketRepo(" buckets/me/files/ ")).toBe("buckets/me/files");
		expect(parseBucketRepo("https://huggingface.co/buckets/me/files")).toBe("buckets/me/files");
	});

	it("returns null (refuses) for anything that is not exactly one namespace and one bucket", () => {
		for (const bad of ["", "me", "me/files/extra", "../me/files", "me/fi les", "buckets//files"]) {
			expect(parseBucketRepo(bad)).toBeNull();
		}
	});
});

describe("normalizePrefix", () => {
	it("is empty for the whole bucket and slash-terminated otherwise", () => {
		expect(normalizePrefix("")).toBe("");
		expect(normalizePrefix("/alpha/files/")).toBe("alpha/files/");
	});

	it("returns null (refuses) a folder with traversal or odd characters", () => {
		for (const bad of ["..", "a/../b", "a/./b", "a b", "a\\b"]) expect(normalizePrefix(bad)).toBeNull();
	});
});

describe("the prefix wall: a linked location never reads, writes or deletes outside its folder", () => {
	const prefix = "alpha/";

	it("allows a normal path under the prefix", () => {
		expect(assertUnderPrefix(prefix, "alpha/documents/a.txt")).toBe("alpha/documents/a.txt");
		expect(resolveUnderPrefix(prefix, "documents", "a.txt")).toBe("alpha/documents/a.txt");
	});

	it("refuses traversal out of the prefix, even when it would normalise back inside the bucket", () => {
		for (const bad of [
			"alpha/../secret.txt",
			"alpha/documents/../../secret.txt",
			"other/a.txt",
			"/alpha/a.txt",
			"alpha//a.txt",
			"alpha/",
			"alpha/a\0.txt",
		]) {
			expect(() => assertUnderPrefix(prefix, bad), bad).toThrow(PathOutsideLocationError);
		}
	});

	it("refuses a file name that is itself a path", () => {
		for (const bad of ["../a.txt", "x/a.txt", "x\\a.txt", "..", "."]) {
			expect(() => resolveUnderPrefix(prefix, "documents", bad), bad).toThrow(PathOutsideLocationError);
		}
	});

	it("with no prefix, still refuses traversal and absolute paths", () => {
		expect(assertUnderPrefix("", "documents/a.txt")).toBe("documents/a.txt");
		expect(() => assertUnderPrefix("", "../a.txt")).toThrow(PathOutsideLocationError);
		expect(() => assertUnderPrefix("", "/a.txt")).toThrow(PathOutsideLocationError);
	});
});
