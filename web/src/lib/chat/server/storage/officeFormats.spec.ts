// CUR-4664: the formats My files gained (spreadsheets, slides, OpenDocument, RTF, JSON, EPUB). Each is
// a real file, made by pandoc and LibreOffice from fixtures/embedded-images/noise.png and a few lines
// of text, so the sniff and the scan meet what a person's own software writes. A seeded scanner that
// matches only noise.png's pixels proves the picture inside each file reached the scanner.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { gzipSync, zipSync } from "fflate";
import type { CsamScanResult } from "./csamScan";
import { scanFileForCsam, UnscannableFileError, type ScanTarget } from "./embeddedImageScan";
import { resolveUploadKind } from "$lib/chat/server/rag/extractFile";
import { CUSTODIAL_ALLOWED_KINDS } from "$lib/chat/constants/custodialUpload";

const fixture = (name: string) =>
	readFileSync(fileURLToPath(new URL(`../fixtures/office-formats/${name}`, import.meta.url)));
const NOISE_PNG = readFileSync(fileURLToPath(new URL("../fixtures/embedded-images/noise.png", import.meta.url)));
const noisePixels = sharp(NOISE_PNG).removeAlpha().raw().toBuffer();
const MATCH: CsamScanResult = { status: "match", bankName: "TEST_BANK", bankContentId: 1, distance: "0" };
const quietLog = { info: () => {}, warn: () => {} };
const blob = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)]);

/** Matches a picture whose pixels are noise.png's, at any size a converter rescaled it to. */
function seededScanner() {
	const calls: string[] = [];
	const scan = async (content: Blob, filename: string): Promise<CsamScanResult> => {
		calls.push(filename);
		const img = sharp(Buffer.from(await content.arrayBuffer()));
		const { width, height } = await img.metadata();
		const noise = await sharp(NOISE_PNG).metadata();
		if (width !== noise.width || height !== noise.height) return { status: "clean" };
		const pixels = await img.removeAlpha().raw().toBuffer();
		return pixels.equals(await noisePixels) ? MATCH : { status: "clean" };
	};
	return { scan, calls };
}

/** The sniff custodialStorage runs: the first 4,100 bytes only, never the whole file. */
const sniffHeader = (bytes: Uint8Array, name: string) => resolveUploadKind({ bytes: bytes.subarray(0, 4100), name });

const CASES: { file: string; kind: string; target: ScanTarget; picture: boolean }[] = [
	{ file: "sheet.xlsx", kind: "xlsx", target: "office", picture: false },
	{ file: "slides-with-picture.pptx", kind: "pptx", target: "office", picture: true },
	{ file: "doc-with-picture.odt", kind: "odt", target: "office", picture: true },
	{ file: "sheet.ods", kind: "ods", target: "office", picture: false },
	{ file: "slides-with-picture.odp", kind: "odp", target: "office", picture: true },
	{ file: "book-with-picture.epub", kind: "epub", target: "office", picture: true },
	{ file: "with-picture.rtf", kind: "rtf", target: "rtf", picture: true },
	{ file: "text-only.rtf", kind: "rtf", target: "rtf", picture: false },
];

describe("the formats My files gained are sniffed from their bytes (CUR-4664)", () => {
	for (const { file, kind } of CASES) {
		it(`sniffs ${file} as ${kind} from its first 4,100 bytes, and allows that kind`, async () => {
			expect(await sniffHeader(fixture(file), file)).toBe(kind);
			expect(CUSTODIAL_ALLOWED_KINDS).toContain(kind);
		});
	}

	it("sniffs a real file as its format whatever its name claims, so a renamed spreadsheet is still a spreadsheet", async () => {
		expect(await sniffHeader(fixture("sheet.ods"), "notes.txt")).toBe("ods");
		expect(await sniffHeader(fixture("with-picture.rtf"), "notes.txt")).toBe("rtf");
	});

	it("takes JSON by its name only when no binary signature is present", async () => {
		const json = new TextEncoder().encode('{"name":"ada","score":3}');
		expect(await resolveUploadKind({ bytes: json, name: "scores.json" })).toBe("json");
		expect(CUSTODIAL_ALLOWED_KINDS).toContain("json");
		// A PNG named .json is an image, never JSON.
		expect(await resolveUploadKind({ bytes: NOISE_PNG, name: "scores.json" })).toBe("image");
	});

	it("refuses a bare zip whose name is not a known office format, rather than storing an archive unchecked", async () => {
		expect(await sniffHeader(fixture("slides-with-picture.pptx"), "slides.zip")).toBeNull();
	});
});

describe("every picture inside the new formats reaches the scanner (CUR-4664)", () => {
	for (const { file, target, picture } of CASES) {
		it(
			picture
				? `finds the seeded picture inside ${file}`
				: `calls ${file}, which holds no picture, clean`,
			async () => {
				const { scan } = seededScanner();
				const result = await scanFileForCsam(blob(fixture(file)), file, target, { scan, logger: quietLog });
				expect(result).toEqual(picture ? MATCH : { status: "clean" });
			}
		);
	}

	it("refuses (fail closed) an RTF picture in a format we cannot decode, like the WMF copy Word writes", async () => {
		const rtf = new TextEncoder().encode("{\\rtf1 {\\nonshppict{\\pict\\wmetafile8\\picw10\\pich10 0100090000}}}");
		const { scan } = seededScanner();
		await expect(scanFileForCsam(blob(rtf), "a.rtf", "rtf", { scan, logger: quietLog })).rejects.toBeInstanceOf(
			UnscannableFileError
		);
	});

	it("refuses (fail closed) an RTF with an embedded object or raw binary data", async () => {
		const { scan } = seededScanner();
		for (const body of ["{\\object\\objemb{\\*\\objdata 0102}}", "{\\pict\\pngblip\\bin4 abcd}"]) {
			const rtf = new TextEncoder().encode(`{\\rtf1 ${body}}`);
			await expect(scanFileForCsam(blob(rtf), "a.rtf", "rtf", { scan, logger: quietLog })).rejects.toBeInstanceOf(
				UnscannableFileError
			);
		}
	});

	it("passes over an office file's saved printer setup, but still scans a picture renamed to that name", async () => {
		const xml = new TextEncoder().encode('<?xml version="1.0"?><Types/>');
		const devmode = new Uint8Array(220).fill(7);
		devmode[0] = 0;
		const { scan } = seededScanner();
		const plain = zipSync({ "[Content_Types].xml": xml, "xl/printerSettings/printerSettings1.bin": devmode });
		await expect(scanFileForCsam(blob(plain), "a.xlsx", "office", { scan, logger: quietLog })).resolves.toEqual({
			status: "clean",
		});
		const disguised = zipSync({ "[Content_Types].xml": xml, "xl/printerSettings/printerSettings1.bin": NOISE_PNG });
		await expect(scanFileForCsam(blob(disguised), "a.xlsx", "office", { scan, logger: quietLog })).resolves.toEqual(
			MATCH
		);
		// A gzip of pictures under that name sniffs as gzip, so it is refused, never passed over.
		const nested = zipSync({
			"[Content_Types].xml": xml,
			"xl/printerSettings/printerSettings1.bin": gzipSync(NOISE_PNG),
		});
		await expect(scanFileForCsam(blob(nested), "a.xlsx", "office", { scan, logger: quietLog })).rejects.toBeInstanceOf(
			UnscannableFileError
		);
	});

	it("still finds an RTF picture when its group carries nested property groups", async () => {
		const hex = NOISE_PNG.toString("hex");
		const rtf = new TextEncoder().encode(
			`{\\rtf1 {\\*\\shppict{\\pict{\\*\\picprop{\\sp{\\sn x}{\\sv 1}}}\\picw48\\pich32\\pngblip\n${hex}}}}`
		);
		const { scan } = seededScanner();
		await expect(scanFileForCsam(blob(rtf), "a.rtf", "rtf", { scan, logger: quietLog })).resolves.toEqual(MATCH);
	});
});
