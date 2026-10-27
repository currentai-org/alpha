import { derived, get, writable } from "svelte/store";
import { CHAT_ATTACHMENTS_MAX_BYTES } from "$lib/chat/constants/uploadLimits";
import { SCANNER_UNREADABLE_IMAGE_MIMES } from "$lib/chat/constants/ragUpload";
import { trackEvent } from "$lib/analytics";

// A phone photo is often 3-5 MB, over chat's 3 MB per message (uploadLimits.ts), so it was
// refused before it reached the model. A photo larger than half that budget is redrawn in the browser
// at a size a vision model reads just as well, so two photos still fit in one message. Anything
// smaller, and anything that isn't a still photo format, is sent untouched. (CUR-2633)

/** An image at or under this many bytes is sent as it is. */
export const SHRINK_ABOVE_BYTES = CHAT_ATTACHMENTS_MAX_BYTES / 2;

/** Longest edge, in pixels, of a shrunk photo. Vision models downsample past this anyway. */
const SHRUNK_LONG_EDGE_PX = 2048;

const SHRINKABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/** Whether `file` is a still image big enough to be redrawn smaller. A GIF keeps its animation. */
export function shouldShrink(file: { type: string; size: number }): boolean {
	return SHRINKABLE.has(file.type.toLowerCase()) && file.size > SHRINK_ABOVE_BYTES;
}

/** The size to draw a `width` × `height` image at so its longest edge is at most `longEdge`. */
export function fitWithin(
	width: number,
	height: number,
	longEdge = SHRUNK_LONG_EDGE_PX
): { width: number; height: number } {
	const scale = Math.min(1, longEdge / Math.max(width, height));
	return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** `name` with its extension replaced by `.jpg`, so the file says what it now is. */
export function asJpegName(name: string): string {
	const dot = name.lastIndexOf(".");
	return `${dot > 0 ? name.slice(0, dot) : name}.jpg`;
}

/**
 * `file` redrawn as a JPEG no larger than {@link SHRUNK_LONG_EDGE_PX} on its long edge, or `file`
 * itself when it needs no shrinking, the browser can't decode it, or the redraw comes out no smaller.
 * Never throws: a photo that can't be shrunk falls through to the size check, which says why it was
 * refused.
 */
export async function shrinkImage(file: File): Promise<File> {
	if (!shouldShrink(file)) return file;
	const jpeg = await toJpeg(file);
	return jpeg && jpeg.size < file.size ? jpeg : file;
}

// An iPhone photo is a HEIC, a screenshot tool may save AVIF or BMP, and a scanner TIFF.
// Chat sends JPEG, PNG, WebP and GIF only, so each of these was refused by name. The browser redraws
// one as a JPEG before the type check when it can decode it: Safari opens HEIC and TIFF, Chromium and
// Firefox open AVIF and BMP. One it can't open is left as it is and refused, naming the types that work. (CUR-3073)

/** Photo types the composer redraws as JPEG when this browser can decode them. */
export const CONVERTIBLE_IMAGE_MIME = ["image/avif", "image/bmp", "image/tiff", "image/heic", "image/heif"];

const CONVERTIBLE_BY_EXTENSION: Record<string, string> = {
	avif: "image/avif",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
	heic: "image/heic",
	heif: "image/heif",
};

/**
 * The photo type `file` is, when it is one the composer redraws as JPEG; undefined otherwise. Falls
 * back to the extension, since some systems hand a HEIC to the browser with no type at all.
 */
export function convertibleType(file: { type: string; name: string }): string | undefined {
	const type = file.type.toLowerCase();
	if (CONVERTIBLE_IMAGE_MIME.includes(type)) return type;
	if (type) return undefined;
	const dot = file.name.lastIndexOf(".");
	return dot > 0 ? CONVERTIBLE_BY_EXTENSION[file.name.slice(dot + 1).toLowerCase()] : undefined;
}

/**
 * `file` redrawn as a JPEG no larger than {@link SHRUNK_LONG_EDGE_PX} on its long edge, or undefined
 * when this browser can't decode it. Never throws, so each caller falls back to the original file.
 */
async function toJpeg(file: File): Promise<File | undefined> {
	if (typeof createImageBitmap !== "function") return undefined;
	try {
		const blob = await redrawAsJpeg(file);
		if (!blob) return undefined;
		return new File([blob], asJpegName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
	} catch {
		return undefined;
	}
}

/**
 * Every file in `files`, with each photo of a {@link CONVERTIBLE_IMAGE_MIME} type redrawn as a JPEG;
 * the order is kept. `jpegOffered` is whether the composer takes a JPEG at all, since there is no
 * point converting a photo for a model that reads none.
 */
export async function convertImages(files: File[], jpegOffered: boolean): Promise<File[]> {
	if (!jpegOffered) return files;
	const converting = files.filter((file) => convertibleType(file)).length;
	if (converting === 0) return files;
	preparingPhotos.update((n) => n + converting);
	try {
		return await Promise.all(files.map(async (file) => (convertibleType(file) ? ((await toJpeg(file)) ?? file) : file)));
	} finally {
		preparingPhotos.update((n) => n - converting);
	}
}

/**
 * `file` redrawn as a JPEG when it is a photo type the server's scanner cannot hash (an
 * iPhone HEIC), so My files can store it; any other file is returned as it is. A HEIC this browser
 * can't decode is returned unchanged too, and the server refuses it by type. Never throws. (CUR-4665)
 */
export async function storablePhoto(file: File): Promise<File> {
	const type = convertibleType(file);
	if (!type || !SCANNER_UNREADABLE_IMAGE_MIMES.includes(type)) return file;
	return (await toJpeg(file)) ?? file;
}

/** The canvas step shared by shrinking and converting: decode, fit, fill white, encode JPEG. */
async function redrawAsJpeg(file: File): Promise<Blob | null> {
	// `from-image` applies the photo's EXIF orientation, so a portrait shot stays upright.
	const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	const { width, height } = fitWithin(bitmap.width, bitmap.height);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		bitmap.close();
		return null;
	}
	// JPEG has no transparency, so a PNG with an alpha channel lands on white rather than black.
	// A pixel value baked into the photo's bytes, not a UI colour, so no theme token applies.
	ctx.fillStyle = "white";
	ctx.fillRect(0, 0, width, height);
	ctx.drawImage(bitmap, 0, 0, width, height);
	bitmap.close();
	return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

/**
 * Photos being shrunk right now, across every way into the composer (pick, paste, drop). A 6 MB photo
 * takes seconds to redraw, and until it resolves the composer has no file to show, so the composer
 * shows one placeholder chip per count (CUR-2905).
 */
export const preparingPhotos = writable(0);

/**
 * Attachments waiting on My files' headroom before they reach the composer (CUR-3235). Counted apart
 * from `preparingPhotos`, which draws a placeholder chip per count, but held by the send all the same.
 */
export const checkingRoom = writable(0);

const attachmentsInFlight = derived([preparingPhotos, checkingRoom], ([photos, room]) => photos + room);

/** Whether a chosen attachment has yet to reach the composer: shrinking, converting, or checking room. */
export function attachmentsPending(): boolean {
	return get(attachmentsInFlight) > 0;
}

/** Resolves the next time no attachment is on its way to the composer, at once if none is (CUR-3197). */
export function photosReady(): Promise<void> {
	if (!attachmentsPending()) return Promise.resolve();
	return new Promise((resolve) => {
		// The first call is synchronous and sees a count above 0, so `unsubscribe` is set by the
		// time the count reaches 0.
		const unsubscribe = attachmentsInFlight.subscribe((n) => {
			if (n > 0) return;
			unsubscribe();
			resolve();
		});
	});
}

/** Every file in `files`, with each large photo shrunk; the order is kept. */
export async function shrinkImages(files: File[]): Promise<File[]> {
	const shrinking = files.filter(shouldShrink).length;
	preparingPhotos.update((n) => n + shrinking);
	try {
		const ready = await Promise.all(files.map(shrinkImage));
		reportPhotoSizes(files, ready);
		return ready;
	} finally {
		preparingPhotos.update((n) => n - shrinking);
	}
}

// Nothing recorded how large the photos people attach are, so nobody could say how many
// arrive over the message limit or how much the shrink saves. One event per photo carries its type and
// byte counts before and after, never its name or contents. (CUR-2633)
function reportPhotoSizes(before: File[], after: File[]) {
	before.forEach((original, i) => {
		if (!original.type.startsWith("image/")) return;
		trackEvent("chat_photo_prepared", {
			type: original.type.toLowerCase(),
			originalBytes: original.size,
			sentBytes: after[i].size,
			shrunk: after[i] !== original,
		});
	});
}
