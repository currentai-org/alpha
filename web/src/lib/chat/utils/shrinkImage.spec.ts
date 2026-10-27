import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import {
	asJpegName,
	attachmentsPending,
	checkingRoom,
	convertibleType,
	convertImages,
	fitWithin,
	photosReady,
	preparingPhotos,
	shouldShrink,
	shrinkImage,
	shrinkImages,
	SHRINK_ABOVE_BYTES,
	storablePhoto,
} from "./shrinkImage";

describe("shrinkImage (CUR-2633)", () => {
	it("leaves a photo at or under the threshold unshrunk, so a small image is sent byte for byte", async () => {
		const small = new File([new Uint8Array(1000)], "small.jpg", { type: "image/jpeg" });
		expect(shouldShrink(small)).toBe(false);
		expect(await shrinkImage(small)).toBe(small);
	});

	it("shrinks only still photos over the threshold; a GIF keeps its animation and a PDF is never touched", () => {
		const big = SHRINK_ABOVE_BYTES + 1;
		expect(shouldShrink({ type: "image/jpeg", size: big })).toBe(true);
		expect(shouldShrink({ type: "image/PNG", size: big })).toBe(true);
		expect(shouldShrink({ type: "image/gif", size: big })).toBe(false);
		expect(shouldShrink({ type: "application/pdf", size: big })).toBe(false);
	});

	it("returns the original, never throws, when this runtime cannot decode images", async () => {
		const big = new File([new Uint8Array(SHRINK_ABOVE_BYTES + 1)], "phone.jpg", { type: "image/jpeg" });
		expect(await shrinkImage(big)).toBe(big);
	});

	it("fits the long edge to 2048 px keeping the aspect ratio, and never enlarges", () => {
		expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
		expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048 });
		expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
	});

	it("names the redrawn file .jpg", () => {
		expect(asJpegName("IMG_0001.PNG")).toBe("IMG_0001.jpg");
		expect(asJpegName("photo")).toBe("photo.jpg");
		expect(asJpegName(".hidden")).toBe(".hidden.jpg");
	});
});

describe("preparingPhotos (CUR-2905)", () => {
	it("counts each photo being shrunk while shrinkImages runs, ignores files it won't shrink, and returns to 0", async () => {
		const big = new File([new Uint8Array(SHRINK_ABOVE_BYTES + 1)], "IMG_1.jpg", { type: "image/jpeg" });
		const small = new File([new Uint8Array(10)], "note.png", { type: "image/png" });
		const pdf = new File([new Uint8Array(SHRINK_ABOVE_BYTES + 1)], "a.pdf", { type: "application/pdf" });
		const pending = shrinkImages([big, small, pdf, big]);
		expect(get(preparingPhotos)).toBe(2);
		await pending;
		expect(get(preparingPhotos)).toBe(0);
	});
});

describe("convertImages (CUR-3073: an iPhone HEIC, an AVIF or a BMP is redrawn as a JPEG before the type check)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** A browser whose canvas encodes every decodable image to `jpegBytes`, and decodes only `decodes`. */
	function stubBrowser(decodes: (file: File) => boolean, jpegBytes = 7) {
		vi.stubGlobal("createImageBitmap", async (file: File) => {
			if (!decodes(file)) throw new DOMException("The source image could not be decoded.", "InvalidStateError");
			return { width: 4032, height: 3024, close() {} };
		});
		vi.stubGlobal("document", {
			createElement: () => ({
				width: 0,
				height: 0,
				getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
				toBlob: (resolve: (blob: Blob) => void, type: string) =>
					resolve(new Blob([new Uint8Array(jpegBytes)], { type })),
			}),
		});
	}

	it("recognises the photo types it converts by type, or by extension when the type is empty", () => {
		expect(convertibleType({ type: "image/avif", name: "a.avif" })).toBe("image/avif");
		expect(convertibleType({ type: "image/HEIC", name: "IMG_0001.HEIC" })).toBe("image/heic");
		expect(convertibleType({ type: "", name: "IMG_0001.HEIC" })).toBe("image/heic");
		expect(convertibleType({ type: "", name: "scan.tif" })).toBe("image/tiff");
	});

	it("never converts a type chat already sends, or a file whose stated type is something else", () => {
		expect(convertibleType({ type: "image/jpeg", name: "a.jpg" })).toBeUndefined();
		expect(convertibleType({ type: "image/gif", name: "a.gif" })).toBeUndefined();
		expect(convertibleType({ type: "application/zip", name: "photo.heic" })).toBeUndefined();
		expect(convertibleType({ type: "", name: "notes" })).toBeUndefined();
	});

	it("redraws a decodable avif as a .jpg JPEG and leaves the PNG beside it untouched, in order", async () => {
		stubBrowser(() => true);
		const avif = new File([new Uint8Array(50)], "blue.avif", { type: "image/avif" });
		const png = new File([new Uint8Array(10)], "shapes.png", { type: "image/png" });
		const [converted, kept] = await convertImages([avif, png], true);
		expect(converted.name).toBe("blue.jpg");
		expect(converted.type).toBe("image/jpeg");
		expect(converted.size).toBe(7);
		expect(kept).toBe(png);
	});

	it("keeps the JPEG even when it is larger than the original, since the original can't be sent at all", async () => {
		stubBrowser(() => true, 500);
		const bmp = new File([new Uint8Array(50)], "red.bmp", { type: "image/bmp" });
		const [converted] = await convertImages([bmp], true);
		expect(converted.type).toBe("image/jpeg");
	});

	it("returns a HEIC this browser can't decode as it was, so the type check refuses it by name", async () => {
		stubBrowser((file) => !file.name.endsWith(".heic"));
		const heic = new File([new Uint8Array(50)], "IMG_0001.heic", { type: "image/heic" });
		const [kept] = await convertImages([heic], true);
		expect(kept).toBe(heic);
	});

	it("storablePhoto: My files sends an iPhone HEIC as a .jpg JPEG, since the scanner cannot hash a HEIC (CUR-4665)", async () => {
		stubBrowser(() => true);
		const heic = new File([new Uint8Array(50)], "IMG_0001.HEIC", { type: "image/heic" });
		const stored = await storablePhoto(heic);
		expect(stored.name).toBe("IMG_0001.jpg");
		expect(stored.type).toBe("image/jpeg");
	});

	it("storablePhoto: leaves every type the scanner reads untouched, and a HEIC this browser can't decode as it was (CUR-4665)", async () => {
		stubBrowser((file) => !file.name.endsWith(".heic"));
		const avif = new File([new Uint8Array(50)], "blue.avif", { type: "image/avif" });
		const jpeg = new File([new Uint8Array(50)], "cat.jpg", { type: "image/jpeg" });
		const heic = new File([new Uint8Array(50)], "IMG_0002.heic", { type: "image/heic" });
		expect(await storablePhoto(avif)).toBe(avif);
		expect(await storablePhoto(jpeg)).toBe(jpeg);
		expect(await storablePhoto(heic)).toBe(heic);
	});

	it("converts nothing for a composer that takes no JPEG, so the photo refusal stays the model's", async () => {
		stubBrowser(() => true);
		const avif = new File([new Uint8Array(50)], "blue.avif", { type: "image/avif" });
		const [kept] = await convertImages([avif], false);
		expect(kept).toBe(avif);
	});

	it("shrinks a large photo to the smaller redraw, and keeps the original when the redraw comes out larger (CUR-2633)", async () => {
		const big = new File([new Uint8Array(SHRINK_ABOVE_BYTES + 1)], "IMG_1.png", { type: "image/png" });
		stubBrowser(() => true);
		const shrunk = await shrinkImage(big);
		expect(shrunk.name).toBe("IMG_1.jpg");
		expect(shrunk.size).toBe(7);
		stubBrowser(() => true, SHRINK_ABOVE_BYTES + 2);
		expect(await shrinkImage(big)).toBe(big);
	});

	it("counts each photo being converted on preparingPhotos and returns to 0", async () => {
		stubBrowser(() => true);
		const avif = new File([new Uint8Array(50)], "blue.avif", { type: "image/avif" });
		const txt = new File(["hi"], "a.txt", { type: "text/plain" });
		const pending = convertImages([avif, txt, avif], true);
		expect(get(preparingPhotos)).toBe(2);
		await pending;
		expect(get(preparingPhotos)).toBe(0);
	});
});

describe("photosReady (CUR-3197)", () => {
	afterEach(() => {
		preparingPhotos.set(0);
		checkingRoom.set(0);
	});

	it("resolves at once when no photo is being prepared", async () => {
		await expect(photosReady()).resolves.toBeUndefined();
	});

	it("waits while a photo is prepared, and resolves when the last one is done", async () => {
		preparingPhotos.set(2);
		let done = false;
		const ready = photosReady().then(() => (done = true));
		preparingPhotos.set(1);
		await Promise.resolve();
		expect(done).toBe(false);
		preparingPhotos.set(0);
		await ready;
		expect(done).toBe(true);
	});

	it("keeps waiting after the shrink ends while My files' headroom is still being read (CUR-3235 regressed CUR-3197)", async () => {
		checkingRoom.set(1);
		preparingPhotos.set(1);
		let done = false;
		const ready = photosReady().then(() => (done = true));
		preparingPhotos.set(0);
		await Promise.resolve();
		expect(attachmentsPending()).toBe(true);
		expect(done).toBe(false);
		checkingRoom.set(0);
		await ready;
		expect(done).toBe(true);
	});
});

describe("chat_photo_prepared (CUR-2633: real photo sizes, before and after the shrink)", () => {
	afterEach(() => {
		vi.doUnmock("$lib/analytics");
		vi.resetModules();
	});

	it("reports each photo's type and byte counts, and nothing for a document or a name", async () => {
		const trackEvent = vi.fn();
		vi.doMock("$lib/analytics", () => ({ trackEvent }));
		vi.resetModules();
		const { shrinkImages: shrink } = await import("./shrinkImage");
		const photo = new File([new Uint8Array(1234)], "holiday-in-lisbon.jpg", { type: "image/JPEG" });
		const pdf = new File([new Uint8Array(99)], "contract.pdf", { type: "application/pdf" });

		await shrink([pdf, photo]);

		expect(trackEvent).toHaveBeenCalledTimes(1);
		expect(trackEvent).toHaveBeenCalledWith("chat_photo_prepared", {
			type: "image/jpeg",
			originalBytes: 1234,
			sentBytes: 1234,
			shrunk: false,
		});
		expect(JSON.stringify(trackEvent.mock.calls)).not.toContain("lisbon");
	});
});
