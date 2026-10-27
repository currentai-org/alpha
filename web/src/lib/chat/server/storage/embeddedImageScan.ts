/**
 * The known-abuse image check for every file a person gives us, including the pictures inside a PDF
 * or an Office file (CUR-987). A photo is scanned as itself. A PDF or DOCX has each embedded image
 * decoded, re-encoded as PNG and scanned, so a picture cannot get past the check by arriving inside
 * a document. Chat attachments (parseRequest.ts) and My files (custodialStorage.ts) both call this.
 *
 * Fails closed: an image that cannot be decoded (JPEG 2000 in this pdf.js build, EMF/WMF in a Word
 * file, which sharp cannot read), a part of the archive we cannot classify, too many images, or a
 * file that runs past the time budget refuses the whole file with {@link UnscannableFileError}.
 *
 * This runs in-process, so the parsers it drives (pdf.js, fflate, libvips through sharp) share the
 * function with its secrets. That is acceptable only for trusted users; parsing in a sandbox with
 * no network and no secrets is the gate on opening it to guests.
 */

import { createHash } from "node:crypto";
import type sharp from "sharp";
import { MAX_PDF_PAGES } from "$lib/chat/constants/ragUpload";
import { logger as defaultLogger } from "$lib/chat/server/logger";
import { scanCsamHash, type CsamScanResult } from "./csamScan";

/** Chat's line for a PDF or DOCX from an account `document-attachments` does not select (CUR-987). */
export const DOCUMENTS_NOT_ACCEPTED_MESSAGE = "PDF and Word files can't be added here yet, so this one wasn't added.";

export const UNSCANNABLE_FILE_MESSAGE = "This file has a picture in it we couldn't check, so it wasn't added.";

const PDF_TOO_LONG_MESSAGE = `This PDF has more than ${MAX_PDF_PAGES.toLocaleString("en")} pages, so it wasn't added.`;

/** The file holds something the check cannot read, so it is refused. A retry gives the same answer,
 *  unlike HmaUnreachableError. `reason` is for logs only, never shown or sent with content; `notice`
 *  is the line chat shows for it. */
export class UnscannableFileError extends Error {
	name = "UnscannableFileError";
	constructor(
		readonly reason: string,
		readonly notice: string = UNSCANNABLE_FILE_MESSAGE
	) {
		super(`file could not be checked: ${reason}`);
	}
}

/** How a file is checked: as an image, by walking a PDF, by walking a zip-based Office file, or not
 *  at all (text, which has no pixels to hash). */
export type ScanTarget = "image" | "pdf" | "office" | null;

const OFFICE_MIMES = new Set([
	"application/zip",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.oasis.opendocument.text",
	"application/vnd.oasis.opendocument.spreadsheet",
	"application/vnd.oasis.opendocument.presentation",
]);

/** The check a sniffed mime gets. Pass the type read from the bytes, never the declared one. */
export function scanTargetForMime(mime: string): ScanTarget {
	if (mime.startsWith("image/")) return "image";
	if (mime === "application/pdf") return "pdf";
	if (OFFICE_MIMES.has(mime)) return "office";
	return null;
}

/** Unique images one file may hold. A long slide deck stays under it; a file built to make us spend
 *  minutes on the scanner does not. */
const MAX_IMAGES = 200;
/** Extraction and every scan together, for one file. */
const FILE_BUDGET_MS = 45_000;
const SCAN_CONCURRENCY = 6;
/** A PDF inside a DOCX inside a DOCX is still walked; deeper than this is refused. */
const MAX_NEST_DEPTH = 3;
/** Uncompressed bytes one archive may expand to, so a zip bomb is refused before it is inflated. */
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
/** pdf.js resolves an image object through a callback that never fires for some broken streams. */
const PDF_OBJECT_TIMEOUT_MS = 5_000;
const MAX_IMAGE_PIXELS = 50_000_000;

export type EmbeddedScanDeps = {
	scan?: typeof scanCsamHash;
	sharpImpl?: typeof sharp;
	logger?: Pick<typeof defaultLogger, "info" | "warn">;
	now?: () => number;
	/** Receives each distinct picture the walk decoded (PNG bytes), for a second screen. (CUR-3201) */
	collected?: Buffer[];
};

type Ctx = {
	deadline: number;
	now: () => number;
	sharp: typeof sharp;
	seen: Set<string>;
	images: Buffer[];
};

/**
 * Scan `content` against the known-abuse list. Returns the first match, or clean. Throws
 * HmaUnreachableError (from scanCsamHash) when the scanner does not answer, and UnscannableFileError
 * when the file cannot be checked; the caller refuses the file on either.
 */
export async function scanFileForCsam(
	content: Blob,
	name: string,
	target: ScanTarget,
	deps: EmbeddedScanDeps = {}
): Promise<CsamScanResult> {
	const scan = deps.scan ?? scanCsamHash;
	if (target === null) return { status: "clean" };
	if (target === "image") return scan(content, name);

	const now = deps.now ?? Date.now;
	const log = deps.logger ?? defaultLogger;
	const started = now();
	const ctx: Ctx = {
		deadline: started + FILE_BUDGET_MS,
		now,
		sharp: deps.sharpImpl ?? (await import("sharp")).default,
		seen: new Set(),
		images: [],
	};
	const bytes = new Uint8Array(await content.arrayBuffer());
	try {
		await collect(bytes, target, ctx, 0);
	} catch (e) {
		if (e instanceof UnscannableFileError) log.warn({ target, reason: e.reason }, "[csam-scan] file refused: unscannable");
		throw e;
	}
	deps.collected?.push(...ctx.images);
	const extractedMs = now() - started;

	let match: CsamScanResult | undefined;
	let next = 0;
	const worker = async () => {
		while (!match && next < ctx.images.length) {
			const i = next++;
			checkDeadline(ctx);
			const result = await scan(new Blob([new Uint8Array(ctx.images[i])], { type: "image/png" }), `${name}#${i + 1}.png`);
			if (result.status === "match") match ??= result;
		}
	};
	await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, ctx.images.length) }, worker));
	log.info(
		{ target, images: ctx.images.length, extractMs: extractedMs, ms: now() - started, matched: Boolean(match) },
		"[csam-scan] embedded images scanned"
	);
	return match ?? { status: "clean" };
}

function checkDeadline(ctx: Ctx) {
	if (ctx.now() > ctx.deadline) throw new UnscannableFileError("time budget exceeded");
}

async function collect(bytes: Uint8Array, target: "pdf" | "office", ctx: Ctx, depth: number): Promise<void> {
	if (depth > MAX_NEST_DEPTH) throw new UnscannableFileError("nested too deep");
	if (target === "pdf") await collectFromPdf(bytes, ctx);
	else await collectFromArchive(bytes, ctx, depth);
}

/** Keep one PNG per distinct picture. Identical pixels arrive many times in a real deck (a logo on
 *  every slide) and need scanning once. */
function keep(png: Buffer, ctx: Ctx) {
	const key = createHash("sha256").update(png).digest("hex");
	if (ctx.seen.has(key)) return;
	ctx.seen.add(key);
	if (ctx.images.length >= MAX_IMAGES) throw new UnscannableFileError("too many images");
	ctx.images.push(png);
}

// ── PDF ────────────────────────────────────────────────────────────────────────────────────────────
// unpdf's own extractImages is not used: it reads paintImageXObject only, so an inline image is never
// seen, and it skips an image pdf.js could not decode, so a JPEG 2000 picture passes as clean.

type PdfImage = { data?: Uint8Array | Uint8ClampedArray; width?: number; height?: number; bitmap?: unknown };

async function collectFromPdf(bytes: Uint8Array, ctx: Ctx): Promise<void> {
	const { getDocumentProxy, getResolvedPDFJS } = await import("unpdf");
	const { OPS } = await getResolvedPDFJS();
	// Every operator that paints an image. A solid-colour mask is a filled rectangle with no pixels.
	const imageOps = new Set(
		Object.entries(OPS)
			.filter(([name]) => /Image/.test(name) && name !== "paintSolidColorImageMask")
			.map(([, code]) => code)
	);
	let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
	try {
		// No eval switch to set: the pdf.js unpdf bundles has no eval path at all (no `new Function`),
		// which is the fix for CVE-2024-4367's code execution from a crafted font.
		pdf = await getDocumentProxy(new Uint8Array(bytes));
	} catch {
		throw new UnscannableFileError("pdf did not open");
	}
	try {
		// Refused before any page is read: opening is cheap, but reading pages is not (CUR-3837).
		if (pdf.numPages > MAX_PDF_PAGES) {
			throw new UnscannableFileError(`pdf has ${pdf.numPages} pages`, PDF_TOO_LONG_MESSAGE);
		}
		for (let p = 1; p <= pdf.numPages; p++) {
			checkDeadline(ctx);
			const page = await pdf.getPage(p);
			const ops = await page.getOperatorList();
			for (let i = 0; i < ops.fnArray.length; i++) {
				if (!imageOps.has(ops.fnArray[i])) continue;
				for (const img of await pdfImagesFor(ops.argsArray[i]?.[0], page)) {
					keep(await pngFromPdfImage(img, ctx), ctx);
				}
			}
			page.cleanup();
		}
	} finally {
		await pdf.cleanup();
	}
}

type PdfPage = Awaited<ReturnType<Awaited<ReturnType<typeof import("unpdf").getDocumentProxy>>["getPage"]>>;

/** The image objects an operator's first argument names: a key into the page's object store, the
 *  image itself (inline images, masks), or a list of them (grouped masks). */
async function pdfImagesFor(arg: unknown, page: PdfPage): Promise<PdfImage[]> {
	if (typeof arg === "string") {
		const store = arg.startsWith("g_") ? page.commonObjs : page.objs;
		const img = await new Promise<PdfImage | null>((resolve) => {
			const timer = setTimeout(() => resolve(null), PDF_OBJECT_TIMEOUT_MS);
			store.get(arg, (o: PdfImage | null) => {
				clearTimeout(timer);
				resolve(o);
			});
		});
		// pdf.js warns and hands back nothing for an image it could not decode.
		if (!img) throw new UnscannableFileError("pdf image did not decode");
		return [img];
	}
	if (Array.isArray(arg)) return arg.flatMap((a) => (a && typeof a === "object" ? [a as PdfImage] : []));
	if (arg && typeof arg === "object") return [arg as PdfImage];
	throw new UnscannableFileError("pdf image operator without an image");
}

async function pngFromPdfImage(img: PdfImage, ctx: Ctx): Promise<Buffer> {
	const { data, width, height } = img;
	if (!data || !width || !height) throw new UnscannableFileError("pdf image without pixel data");
	if (width * height > MAX_IMAGE_PIXELS) throw new UnscannableFileError("pdf image too large");
	const px = width * height;
	let raw: Uint8Array;
	let channels: 1 | 3 | 4;
	if (data.length === px * 4) [raw, channels] = [data as Uint8Array, 4];
	else if (data.length === px * 3) [raw, channels] = [data as Uint8Array, 3];
	else if (data.length === px) [raw, channels] = [data as Uint8Array, 1];
	else if (data.length === Math.ceil(width / 8) * height) [raw, channels] = [unpackOneBit(data, width, height), 1];
	else throw new UnscannableFileError("pdf image in an unknown pixel layout");
	return ctx.sharp(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), { raw: { width, height, channels } })
		.png()
		.toBuffer();
}

/** pdf.js's 1-bit layout: rows padded to a byte, most significant bit first, a set bit is white. */
function unpackOneBit(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
	const rowBytes = Math.ceil(width / 8);
	const out = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			out[y * width + x] = data[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
		}
	}
	return out;
}

// ── Office (zip) ───────────────────────────────────────────────────────────────────────────────────
// Every part of the archive is accounted for: an image is decoded and scanned, a PDF or nested Office
// file is walked, XML and fonts are passed over, and anything else (an EMF/WMF drawing, an OLE
// object, an unknown binary) refuses the file, because it may hold a picture we cannot see.

async function collectFromArchive(bytes: Uint8Array, ctx: Ctx, depth: number): Promise<void> {
	const { unzipSync } = await import("fflate");
	let total = 0;
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(bytes, {
			filter: (f) => {
				total += f.originalSize;
				if (total > MAX_UNZIPPED_BYTES) throw new UnscannableFileError("archive expands too far");
				return !f.name.endsWith("/");
			},
		});
	} catch (e) {
		if (e instanceof UnscannableFileError) throw e;
		throw new UnscannableFileError("archive did not open");
	}
	const { fileTypeFromBuffer } = await import("file-type");
	for (const [name, entry] of Object.entries(entries)) {
		checkDeadline(ctx);
		if (entry.length === 0) continue;
		const mime = (await fileTypeFromBuffer(entry))?.mime;
		const target = mime ? scanTargetForMime(mime) : null;
		if (target === "image" || isSvg(name, entry)) {
			keep(await pngFromImageBytes(entry, ctx), ctx);
		} else if (target === "pdf" || target === "office") {
			await collect(entry, target, ctx, depth + 1);
		} else if (mime?.startsWith("font/") || mime === "application/xml" || (!mime && isMarkupOrText(entry))) {
			// Document structure and fonts: no pixels.
		} else if (/\.(odttf|fntdata)$/i.test(name)) {
			// Word's obfuscated embedded fonts, which no sniffer recognises.
		} else {
			throw new UnscannableFileError(`archive part of type ${mime ?? "unknown"}`);
		}
	}
}

async function pngFromImageBytes(bytes: Uint8Array, ctx: Ctx): Promise<Buffer> {
	try {
		return await ctx.sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).png().toBuffer();
	} catch {
		throw new UnscannableFileError("embedded image did not decode");
	}
}

function isSvg(name: string, bytes: Uint8Array): boolean {
	if (/\.svg$/i.test(name)) return true;
	const head = new TextDecoder().decode(bytes.subarray(0, 512));
	return /<svg[\s>]/i.test(head);
}

/** XML, relationships and other UTF-8 text parts. A NUL byte in the first 4 KB marks binary. */
function isMarkupOrText(bytes: Uint8Array): boolean {
	const head = bytes.subarray(0, 4096);
	if (head.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(head.length < bytes.length ? head.subarray(0, lastCharBoundary(head)) : head);
		return true;
	} catch {
		return false;
	}
}

/** Trim a cut-off multi-byte character from the end of a slice so a fatal decode judges the rest. */
function lastCharBoundary(b: Uint8Array): number {
	let end = b.length;
	for (let back = 1; back <= 3 && end - back >= 0; back++) {
		const c = b[end - back];
		if ((c & 0xc0) === 0x80) continue;
		if (c >= 0xc0) end -= back;
		break;
	}
	return end;
}
