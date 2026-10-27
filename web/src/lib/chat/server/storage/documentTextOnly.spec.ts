import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { documentAsText } from './documentTextOnly';

const quietLog = { info: () => {} };
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)));
// Text above a picture: the picture is the HMA test bank's own image (e2e/scenarios/fixtures).
const GARDEN_PDF = read('../../../../../e2e/scenarios/fixtures/garden-report-bank-image.pdf');
// One picture and no text layer.
const PICTURE_ONLY_PDF = read('../fixtures/embedded-images/xobject.pdf');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const xml = (s: string) => new TextEncoder().encode(s);
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** The smallest DOCX mammoth reads: a main document reached through the package relationships. */
function docx(body: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
	return zipSync({
		'[Content_Types].xml': xml(
			'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'<Default Extension="xml" ContentType="application/xml"/>' +
				'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
		),
		'_rels/.rels': xml(
			'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
		),
		'word/document.xml': xml(
			`<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`
		),
		...extra
	});
}

/** Rewrite every central-directory entry's declared uncompressed size, leaving the data alone. */
function declareSize(zip: Uint8Array, size: number): Uint8Array {
	const out = new Uint8Array(zip);
	const view = new DataView(out.buffer);
	for (let i = 0; i + 46 <= out.length; i++) {
		if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, size, true);
	}
	return out;
}

const file = (bytes: Uint8Array, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });

describe('documentAsText (CUR-987, document-text-only)', () => {
	it('keeps only the text of a PDF that also holds a picture, as a .txt with no picture bytes in it', async () => {
		const out = await documentAsText(file(GARDEN_PDF, 'report.pdf', 'application/pdf'), 'application/pdf', {
			logger: quietLog
		});
		expect(out.status).toBe('text');
		if (out.status !== 'text') return;
		expect(out.file.name).toBe('report.pdf.txt');
		expect(out.file.type).toBe('text/plain');
		const text = await out.file.text();
		expect(text).toBe('Quarterly garden report. The picture below is the figure for this quarter.');
		// The source is kilobytes of image stream; what is kept is the sentence alone.
		expect(out.file.size).toBe(new TextEncoder().encode(text).length);
		expect(GARDEN_PDF.length).toBeGreaterThan(out.file.size * 10);
	});

	it('reads a DOCX to its text', async () => {
		const out = await documentAsText(file(docx('Résumé — naïve'), 'cv.docx', DOCX_MIME), DOCX_MIME, {
			logger: quietLog
		});
		expect(out.status).toBe('text');
		if (out.status === 'text') expect((await out.file.text()).trim()).toBe('Résumé — naïve');
	});

	it('reads a DOCX that sniffs as a bare zip, by its .docx name', async () => {
		const out = await documentAsText(file(docx('plain words'), 'cv.docx', 'application/zip'), 'application/zip', {
			logger: quietLog
		});
		expect(out.status).toBe('text');
	});

	it('answers unreadable, keeping nothing, for a PDF that is only a picture', async () => {
		const out = await documentAsText(file(PICTURE_ONLY_PDF, 'scan.pdf', 'application/pdf'), 'application/pdf', {
			logger: quietLog
		});
		expect(out).toEqual({ status: 'unreadable' });
	});

	it('refuses a DOCX whose directory declares a zip bomb, before mammoth inflates any of it', async () => {
		const extract = vi.fn();
		const bomb = declareSize(docx('x'), 150 * 1024 * 1024);
		const out = await documentAsText(file(bomb, 'bomb.docx', DOCX_MIME), DOCX_MIME, { extract, logger: quietLog });
		expect(out).toEqual({ status: 'unreadable' });
		expect(extract).not.toHaveBeenCalled();
	});

	it('answers unsupported for a spreadsheet, and for a zip that is not named .docx', async () => {
		const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
		expect(await documentAsText(file(docx('x'), 'sheet.xlsx', xlsx), xlsx)).toEqual({ status: 'unsupported' });
		expect(await documentAsText(file(docx('x'), 'a.zip', 'application/zip'), 'application/zip')).toEqual({
			status: 'unsupported'
		});
	});
});
