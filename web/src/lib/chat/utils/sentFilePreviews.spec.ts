import { describe, expect, it } from "vitest";
import { sha256 } from "./sha256";
import { rememberSentFile, sentFilePreview } from "./sentFilePreviews";

// A JPEG's first bytes are not valid UTF-8, which is the case where reading bytes as text is lossy
// and the two sides could disagree if either read them differently.
const jpegLike = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x80, 0xc3]);
const base64 = jpegLike.toString("base64");

/** How uploadFile.ts names the stored copy of the File parseRequest.ts builds from the upload. */
async function serverKey(b64: string): Promise<string> {
	const file = new File([Buffer.from(b64, "base64")], "IMG_4032.jpg", { type: "image/jpeg" });
	return sha256(await file.text());
}

describe("sentFilePreviews (CUR-2761)", () => {
	it("finds a sent image under the hash the server stores it as, invalid UTF-8 included", async () => {
		await rememberSentFile("image/jpeg", base64);
		expect(sentFilePreview(await serverKey(base64))).toBe(`data:image/jpeg;base64,${base64}`);
		// The tempting shortcut, hashing the base64 text, names nothing the server stores.
		expect(sentFilePreview(await sha256(base64))).toBeUndefined();
	});

	it("returns nothing for a stored image this browser never attached, so it downloads as before", () => {
		expect(sentFilePreview("0".repeat(64))).toBeUndefined();
	});

	it("keeps only the 16 most recent images", async () => {
		const keys: string[] = [];
		for (let i = 0; i < 17; i++) {
			const b64 = Buffer.from([0xff, 0xd8, i]).toString("base64");
			await rememberSentFile("image/jpeg", b64);
			keys.push(await serverKey(b64));
		}
		expect(sentFilePreview(keys[0])).toBeUndefined();
		expect(sentFilePreview(keys[16])).toBeDefined();
	});
});
