import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { screenRendition } from "./screenRendition";

async function flat(width: number, height: number): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: "#1040d0" } })
		.png()
		.toBuffer();
}

describe("screenRendition", () => {
	it("a picture smaller than 1024x1024 reaches the safety screen at its own size, never blown up", async () => {
		const meta = await sharp(await screenRendition(sharp, await flat(64, 64))).metadata();
		expect([meta.width, meta.height]).toEqual([64, 64]);
	});

	it("a picture larger than 1024x1024 is scaled down to fit inside it, keeping its shape", async () => {
		const meta = await sharp(await screenRendition(sharp, await flat(3000, 2000))).metadata();
		expect([meta.width, meta.height]).toEqual([1024, 683]);
	});

	it("the screen always reads a JPEG, whatever was uploaded", async () => {
		const meta = await sharp(await screenRendition(sharp, await flat(64, 64))).metadata();
		expect(meta.format).toBe("jpeg");
	});
});
