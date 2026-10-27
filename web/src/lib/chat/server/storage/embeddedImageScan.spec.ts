import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { zipSync } from 'fflate';
import { HmaUnreachableError, type CsamScanResult } from './csamScan';
import { scanFileForCsam, scanTargetForMime, UnscannableFileError } from './embeddedImageScan';

const fixture = (name: string) =>
	readFileSync(fileURLToPath(new URL(`../fixtures/embedded-images/${name}`, import.meta.url)));
const blob = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)]);
const quietLog = { info: () => {}, warn: () => {} };

const NOISE_PNG = fixture('noise.png');
const noisePixels = sharp(NOISE_PNG).removeAlpha().raw().toBuffer();
const MATCH: CsamScanResult = { status: 'match', bankName: 'TEST_BANK', bankContentId: 1, distance: '0' };

/** A scanner standing in for HMA: it matches only the seeded noise picture, compared by its pixels,
 *  so a match proves that exact embedded image reached the scanner. Records every call. */
function seededScanner() {
	const calls: string[] = [];
	const scan = async (content: Blob, filename: string): Promise<CsamScanResult> => {
		calls.push(filename);
		const pixels = await sharp(Buffer.from(await content.arrayBuffer())).removeAlpha().raw().toBuffer();
		return pixels.equals(await noisePixels) ? MATCH : { status: 'clean' };
	};
	return { scan, calls };
}

async function solidPng(rgb: [number, number, number], size = 8): Promise<Uint8Array> {
	const [r, g, b] = rgb;
	return sharp({ create: { width: size, height: size, channels: 3, background: { r, g, b } } })
		.png()
		.toBuffer();
}

/** The parts every DOCX carries, plus whatever a test adds. */
function docx(parts: Record<string, Uint8Array>): Uint8Array {
	const xml = (s: string) => new TextEncoder().encode(s);
	return zipSync({
		'[Content_Types].xml': xml('<?xml version="1.0"?><Types/>'),
		'_rels/.rels': xml('<?xml version="1.0"?><Relationships/>'),
		'word/document.xml': xml('<?xml version="1.0"?><w:document>Résumé — naïve</w:document>'),
		...parts
	});
}

describe('scanTargetForMime', () => {
	it('walks PDFs and zip-based Office files, scans images as themselves, and leaves text alone', () => {
		expect(scanTargetForMime('image/png')).toBe('image');
		expect(scanTargetForMime('application/pdf')).toBe('pdf');
		expect(
			scanTargetForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
		).toBe('office');
		expect(scanTargetForMime('text/plain')).toBeNull();
	});
});

describe('scanFileForCsam on a PDF (CUR-987)', () => {
	it('finds a seeded match in an image drawn as an XObject', async () => {
		const { scan, calls } = seededScanner();
		await expect(scanFileForCsam(blob(fixture('xobject.pdf')), 'a.pdf', 'pdf', { scan, logger: quietLog })).resolves.toEqual(MATCH);
		expect(calls).toHaveLength(1);
	});

	it('finds a seeded match in an inline image, which unpdf extractImages never reads', async () => {
		const { scan } = seededScanner();
		await expect(scanFileForCsam(blob(fixture('inline.pdf')), 'a.pdf', 'pdf', { scan, logger: quietLog })).resolves.toEqual(MATCH);
	});

	it('scans a picture drawn three times once', async () => {
		const { scan, calls } = seededScanner();
		await scanFileForCsam(blob(fixture('repeated.pdf')), 'a.pdf', 'pdf', { scan, logger: quietLog });
		expect(calls).toHaveLength(1);
	});

	it('refuses (fail closed) a PDF whose image this pdf.js cannot decode, rather than calling it clean', async () => {
		const { scan, calls } = seededScanner();
		await expect(
			scanFileForCsam(blob(fixture('jpeg2000.pdf')), 'a.pdf', 'pdf', { scan, logger: quietLog })
		).rejects.toBeInstanceOf(UnscannableFileError);
		expect(calls).toHaveLength(0);
	});

	it('calls a PDF with no pictures clean without asking the scanner', async () => {
		const { scan, calls } = seededScanner();
		await expect(scanFileForCsam(blob(fixture('text-only.pdf')), 'a.pdf', 'pdf', { scan, logger: quietLog })).resolves.toEqual({ status: 'clean' });
		expect(calls).toHaveLength(0);
	});

	it('refuses bytes that are not a PDF at all', async () => {
		const { scan } = seededScanner();
		await expect(
			scanFileForCsam(blob(new TextEncoder().encode('%PDF-1.7 truncated')), 'a.pdf', 'pdf', { scan, logger: quietLog })
		).rejects.toBeInstanceOf(UnscannableFileError);
	});

	it('lets an unreachable scanner propagate, so the caller refuses with the try-again line', async () => {
		const scan = async () => {
			throw new HmaUnreachableError(new Error('down'));
		};
		await expect(
			scanFileForCsam(blob(fixture('xobject.pdf')), 'a.pdf', 'pdf', { scan, logger: quietLog })
		).rejects.toBeInstanceOf(HmaUnreachableError);
	});
});

describe('scanFileForCsam on a DOCX (CUR-987)', () => {
	it("finds a seeded match among word/media's pictures", async () => {
		const { scan, calls } = seededScanner();
		const file = docx({ 'word/media/image1.png': await solidPng([10, 20, 30]), 'word/media/image2.png': NOISE_PNG });
		await expect(scanFileForCsam(blob(file), 'a.docx', 'office', { scan, logger: quietLog })).resolves.toEqual(MATCH);
		expect(calls.length).toBeGreaterThanOrEqual(1);
	});

	it('finds a seeded match in a PDF embedded inside the DOCX', async () => {
		const { scan } = seededScanner();
		const file = docx({ 'word/embeddings/report.pdf': fixture('xobject.pdf') });
		await expect(scanFileForCsam(blob(file), 'a.docx', 'office', { scan, logger: quietLog })).resolves.toEqual(MATCH);
	});

	it('finds a picture hidden outside word/media, wherever the archive puts it', async () => {
		const { scan } = seededScanner();
		const file = docx({ 'customXml/item9.bin': NOISE_PNG });
		await expect(scanFileForCsam(blob(file), 'a.docx', 'office', { scan, logger: quietLog })).resolves.toEqual(MATCH);
	});

	it('refuses (fail closed) a DOCX with an EMF drawing, which sharp cannot decode', async () => {
		// An EMF header: record type 1, then the " EMF" signature at byte 40.
		const emf = new Uint8Array(108);
		emf.set([1, 0, 0, 0, 108, 0, 0, 0]);
		emf.set([0x20, 0x45, 0x4d, 0x46], 40);
		const { scan } = seededScanner();
		await expect(
			scanFileForCsam(blob(docx({ 'word/media/image1.emf': emf })), 'a.docx', 'office', { scan, logger: quietLog })
		).rejects.toBeInstanceOf(UnscannableFileError);
	});

	it('calls a DOCX of only text and structure clean without asking the scanner', async () => {
		const { scan, calls } = seededScanner();
		await expect(scanFileForCsam(blob(docx({})), 'a.docx', 'office', { scan, logger: quietLog })).resolves.toEqual({ status: 'clean' });
		expect(calls).toHaveLength(0);
	});

	it('refuses a DOCX with more distinct pictures than the per-file limit', async () => {
		const parts: Record<string, Uint8Array> = {};
		for (let i = 0; i < 201; i++) parts[`word/media/image${i}.png`] = await solidPng([i, 255 - i, 7], 2);
		const { scan } = seededScanner();
		await expect(
			scanFileForCsam(blob(docx(parts)), 'a.docx', 'office', { scan, logger: quietLog })
		).rejects.toMatchObject({ reason: 'too many images' });
	});

	it('refuses a file once the time budget runs out', async () => {
		let t = 0;
		const now = () => (t += 30_000);
		const { scan } = seededScanner();
		const file = docx({ 'word/media/a.png': await solidPng([1, 2, 3]), 'word/media/b.png': await solidPng([4, 5, 6]) });
		await expect(
			scanFileForCsam(blob(file), 'a.docx', 'office', { scan, logger: quietLog, now })
		).rejects.toMatchObject({ reason: 'time budget exceeded' });
	});
});

describe('scanFileForCsam on an image or text', () => {
	it('sends an image as its own bytes, and never scans text', async () => {
		const { scan, calls } = seededScanner();
		await expect(scanFileForCsam(blob(NOISE_PNG), 'p.png', 'image', { scan })).resolves.toEqual(MATCH);
		await expect(scanFileForCsam(blob(new Uint8Array([104, 105])), 't.txt', null, { scan })).resolves.toEqual({ status: 'clean' });
		expect(calls).toEqual(['p.png']);
	});
});

describe('a PDF over the page limit (CUR-3837)', () => {
	it('is refused with the page-limit notice before the scanner sees anything', async () => {
		const bytes = readFileSync(fileURLToPath(new URL('../../../../../e2e/scenarios/fixtures/too-many-pages.pdf', import.meta.url)));
		const { scan, calls } = seededScanner();
		const out = scanFileForCsam(blob(bytes), 'p.pdf', 'pdf', { scan, logger: quietLog });
		await expect(out).rejects.toBeInstanceOf(UnscannableFileError);
		await expect(out).rejects.toMatchObject({ notice: "This PDF has more than 1,000 pages, so it wasn't added." });
		expect(calls).toEqual([]);
	});
});
