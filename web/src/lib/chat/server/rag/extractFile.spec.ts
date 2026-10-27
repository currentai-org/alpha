import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	csvToText,
	jsonToText,
	extractTextFromUpload,
	resolveUploadKind,
	RagExtractError,
} from "./extractFile";

const enc = (s: string) => new TextEncoder().encode(s);

/** A PDF of `n` pages that all show one shared content stream reading "x". */
function pagesPdf(n: number): Uint8Array {
	const objs: string[] = [];
	const kids = Array.from({ length: n }, (_, i) => `${4 + i} 0 R`).join(" ");
	const content = "BT /F1 12 Tf 72 720 Td (x) Tj ET";
	objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objs[2] = `<< /Type /Pages /Count ${n} /Kids [${kids}] >>`;
	objs[3] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
	for (let i = 0; i < n; i++)
		objs[4 + i] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R >>";
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let k = 1; k < objs.length; k++) {
		offsets[k] = out.length;
		out += `${k} 0 obj\n${objs[k]}\nendobj\n`;
	}
	const xref = out.length;
	out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
	for (let k = 1; k < objs.length; k++) out += `${String(offsets[k]).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return enc(out);
}

describe("csvToText", () => {
	it("labels each row by header and separates rows with a blank line", async () => {
		const out = await csvToText("name,role\nAda,eng\nGrace,sci\n");
		expect(out).toBe("name: Ada; role: eng\n\nname: Grace; role: sci");
	});

	it("skips empty cells and all-empty rows", async () => {
		const out = await csvToText("a,b\n1,\n,\n,2\n");
		expect(out).toBe("a: 1\n\nb: 2");
	});

	it("supports TSV when tsv=true", async () => {
		const out = await csvToText("a\tb\n1\t2", true);
		expect(out).toBe("a: 1; b: 2");
	});
});

describe("jsonToText", () => {
	it("renders an array of objects as labeled blocks", () => {
		expect(jsonToText('[{"x":1,"y":"hi"},{"x":2}]', false)).toBe("x: 1\ny: hi\n\nx: 2");
	});

	it("renders a single object", () => {
		expect(jsonToText('{"a":"b"}', false)).toBe("a: b");
	});

	it("stringifies nested values", () => {
		expect(jsonToText('{"meta":{"k":1}}', false)).toBe('meta: {"k":1}');
	});

	it("parses JSONL line by line", () => {
		expect(jsonToText('{"a":1}\n{"a":2}\n', true)).toBe("a: 1\n\na: 2");
	});

	it("throws on invalid JSON (non-jsonl)", () => {
		expect(() => jsonToText("{not json", false)).toThrow(RagExtractError);
	});

	it("keeps a bad JSONL line as raw text rather than dropping content", () => {
		expect(jsonToText('{"a":1}\noops\n', true)).toBe("a: 1\n\noops");
	});
});

describe("extractTextFromUpload", () => {
	it("decodes plain text and titles from the filename", async () => {
		const r = await extractTextFromUpload({
			bytes: enc("hello world"),
			name: "n.txt",
			kind: "text",
		});
		expect(r).toMatchObject({ title: "n", text: "hello world", sourceType: "text" });
	});

	it("keeps Markdown raw (headings carry signal)", async () => {
		const r = await extractTextFromUpload({
			bytes: enc("# H\n\npara"),
			name: "my_notes.md",
			kind: "markdown",
		});
		expect(r.text).toContain("# H");
		expect(r.title).toBe("my notes");
	});

	it("extracts visible text from HTML", async () => {
		const r = await extractTextFromUpload({
			bytes: enc("<title>T</title><body><p>Hi there</p></body>"),
			name: "p.html",
			kind: "html",
		});
		expect(r.text).toContain("Hi there");
	});

	// Chat attachments arrive as base64 and decode to a Node Buffer, often a view into Node's shared
	// pool. unpdf refuses a Buffer outright, and the refusal read as "corrupt" (CUR-987).
	it("reads a PDF handed over as a pooled Buffer, the shape a chat attachment decodes to", async () => {
		const fixture = readFileSync(
			join(import.meta.dirname, "../../../../../e2e/scenarios/fixtures/expenses-policy.pdf")
		);
		const bytes = Buffer.from(fixture.toString("base64"), "base64");
		const out = await extractTextFromUpload({ bytes, name: "expenses-policy.pdf", kind: "pdf" });
		expect(out.text).toContain("37 EUR");
	});

	// A few KB of PDF can name thousands of pages, and reading them all takes 10.7 s at 10,000 and runs
	// node out of memory at 30,000 (CUR-3837). The limit is checked before any page is read.
	it("refuses a PDF over the page limit before reading any page, naming the limit", async () => {
		const bytes = readFileSync(
			join(import.meta.dirname, "../../../../../e2e/scenarios/fixtures/too-many-pages.pdf")
		);
		const out = extractTextFromUpload({ bytes, name: "too-many-pages.pdf", kind: "pdf" });
		await expect(out).rejects.toThrow(RagExtractError);
		await expect(out).rejects.toThrow("This PDF has 1,001 pages; the limit is 1,000.");
	});

	it("still reads a PDF at exactly the page limit", async () => {
		const out = await extractTextFromUpload({ bytes: pagesPdf(1_000), name: "long.pdf", kind: "pdf" });
		expect(out.text).toContain("x");
	});

	it("rejects empty files", async () => {
		await expect(
			extractTextFromUpload({ bytes: enc(""), name: "e.txt", kind: "text" })
		).rejects.toThrow(RagExtractError);
	});

	it("rejects the image kind (images are captioned, not text-extracted)", async () => {
		await expect(
			extractTextFromUpload({ bytes: enc("x"), name: "p.png", kind: "image" })
		).rejects.toThrow(RagExtractError);
	});
});

describe("resolveUploadKind", () => {
	it("classifies text/data formats by extension", async () => {
		expect(await resolveUploadKind({ bytes: enc("x"), name: "a.csv" })).toBe("csv");
		expect(await resolveUploadKind({ bytes: enc("x"), name: "b.md" })).toBe("markdown");
		expect(await resolveUploadKind({ bytes: enc("{}"), name: "c.json" })).toBe("json");
	});

	it("returns null for unsupported types", async () => {
		expect(await resolveUploadKind({ bytes: enc("x"), name: "d.exe" })).toBeNull();
	});
});
