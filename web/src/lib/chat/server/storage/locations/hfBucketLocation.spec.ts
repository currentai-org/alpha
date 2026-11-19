import { describe, expect, it, vi } from "vitest";

const hubList = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("@huggingface/hub", async (orig) => {
	const real = await orig<Record<string, unknown>>();
	return {
		...real,
		listFiles: vi.fn(async function* (params: Record<string, unknown>) {
			hubList.calls.push(params);
			yield { type: "directory", path: "docs", size: 0 };
			yield { type: "file", path: "docs/old.txt", size: 3, uploadedAt: "2026-11-01T10:00:00.000Z" };
			yield { type: "file", path: "docs/new.txt", size: 5, uploadedAt: "2026-11-18T10:00:00.000Z" };
			yield { type: "file", path: "docs/undated.txt", size: 1 };
		}),
	};
});

import {
	assertUnderPrefix,
	normalizePrefix,
	parseBucketRepo,
	PathOutsideLocationError,
	hfBucketLocation,
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

describe("a linked bucket's listing", () => {
	it("asks the Hub for each file's upload time and returns it as addedAt, leaving a file without one undated", async () => {
		const loc = hfBucketLocation({
			id: "loc1",
			label: "mine",
			userId: "u1",
			repo: "buckets/me/files",
			prefix: "",
			token: "hf_example",
		});
		const files = await loc.list();
		expect(hubList.calls[0]?.expand, "the Hub only returns uploadedAt when the listing is expanded").toBe(true);
		expect(files).toEqual([
			{ path: "docs/old.txt", size: 3, addedAt: "2026-11-01T10:00:00.000Z" },
			{ path: "docs/new.txt", size: 5, addedAt: "2026-11-18T10:00:00.000Z" },
			{ path: "docs/undated.txt", size: 1, addedAt: undefined },
		]);
	});
});
