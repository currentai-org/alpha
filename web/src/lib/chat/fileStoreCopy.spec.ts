import { describe, expect, it } from "vitest";
import { m } from "$lib/paraglide/messages.js";
import { fileStoreOf, filesHomeCopy, whereKeptCopy, type FileStore } from "./fileStoreCopy";

const ORG = "Example Org";
const copies = [filesHomeCopy, whereKeptCopy];

describe("where files are kept names the store this deployment uses", () => {
	it("a local or S3 store never says Hugging Face, unless the person linked a bucket of their own", () => {
		for (const store of ["local", "s3"] as FileStore[]) {
			for (const copy of copies) {
				expect(copy(store, false, ORG)).not.toMatch(/Hugging Face/);
				expect(copy(store, false, ORG)).toContain(ORG);
				// The linked bucket is the person's own Hugging Face account; only that clause names it.
				expect(copy(store, true, ORG)).toMatch(/your own Hugging Face account/);
				expect(copy(store, true, ORG).split("Hugging Face").length - 1).toBe(1);
			}
		}
		expect(filesHomeCopy("local", false, ORG)).toMatch(/on the server Example Org runs this app on/);
		expect(filesHomeCopy("s3", false, ORG)).toMatch(/S3-compatible file store Example Org set up/);
	});

	it("the Hugging Face store keeps today's sentences", () => {
		const organisation = "Current AI";
		expect(filesHomeCopy("hf-bucket", false, organisation)).toBe(m.data_filesHome({ organisation }));
		expect(filesHomeCopy("hf-bucket", true, organisation)).toBe(m.data_filesHomeLinked({ organisation }));
		expect(whereKeptCopy("hf-bucket", false, organisation)).toBe(m.storage_whereKeptBody({ organisation }));
		expect(whereKeptCopy("hf-bucket", true, organisation)).toBe(m.storage_whereKeptBodyLinked({ organisation }));
	});

	it("a page with no store loaded reads as the Hugging Face bucket", () => {
		expect(fileStoreOf(undefined)).toBe("hf-bucket");
		expect(fileStoreOf({ fileStore: null })).toBe("hf-bucket");
		expect(fileStoreOf({ fileStore: "local" })).toBe("local");
	});
});
