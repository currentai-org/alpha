// Admin ingest-from-url (Phase 3): fetch a public URL and extract reviewable text to PRE-FILL the
// create form — a human approves it before anything is saved. Uses ssrfStrictFetch from urlSafety
// (validates resolved IPs + every redirect hop, AND blocks cluster-internal ranges like 10/8 and
// IPv6 ULA — stricter than the default ssrfSafeFetch, which allows internal LBs), NOT the public
// /api/fetch-url. HTTPS-only, HTML/plain-text only, size- and time-bounded (streamed, not buffered).

import { isValidUrlStrict, ssrfStrictFetch } from "$lib/chat/server/urlSafety";
import { extractReadableHtml } from "./readableExtract";
import { readCappedBytes } from "$lib/chat/server/readCappedBody";

const MAX_INGEST_BYTES = 2_000_000; // 2 MB — admin-pasted articles, not whole sites
const INGEST_TIMEOUT_MS = 12_000;

/** A fetch/extraction problem the route maps to a 4xx (bad/unsafe URL, wrong type, too big, empty). */
export class RagIngestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RagIngestError";
	}
}

/** Read a response body as text with a HARD byte cap, aborting the stream the moment it's exceeded —
 *  so a body with no/lying content-length (or a decompression bomb) can't be fully buffered. The
 *  caller's AbortController also stays armed across this read, so the time cap covers the body too. */
export async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
	if (!res.body) return (await res.text()).slice(0, maxBytes);
	const bytes = await readCappedBytes(res, maxBytes);
	if (!bytes) throw new RagIngestError("That page is too large to ingest.");
	return new TextDecoder("utf-8").decode(bytes);
}

/** Fetch `rawUrl` safely and return `{ title, text, url }` for the admin to review and edit. */
export async function ingestUrl(
	rawUrl: string
): Promise<{ title: string; text: string; url: string }> {
	const url = (rawUrl ?? "").trim();
	if (!isValidUrlStrict(url)) {
		throw new RagIngestError(
			"Enter a valid, public https URL (internal/private addresses are blocked)."
		);
	}

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), INGEST_TIMEOUT_MS);
	try {
		let res: Response;
		try {
			res = await ssrfStrictFetch(url, {
				redirect: "follow",
				signal: ac.signal,
				headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
			});
		} catch {
			throw new RagIngestError("Could not fetch that URL (blocked, unreachable, or timed out).");
		}

		if (!res.ok) {
			throw new RagIngestError(`The URL returned an error (${res.status}).`);
		}
		const contentType = (res.headers.get("content-type") || "").toLowerCase();
		const isHtml = contentType.includes("text/html");
		const isPlain = contentType.includes("text/plain");
		if (!isHtml && !isPlain) {
			throw new RagIngestError(
				`Unsupported content type${contentType ? ` (${contentType.split(";")[0]})` : ""}; need an HTML page or plain text.`
			);
		}
		const declaredLength = Number(res.headers.get("content-length") || 0);
		if (declaredLength && declaredLength > MAX_INGEST_BYTES) {
			throw new RagIngestError("That page is too large to ingest.");
		}

		let raw: string;
		try {
			raw = await readBoundedText(res, MAX_INGEST_BYTES);
		} catch (e) {
			if (e instanceof RagIngestError) throw e;
			throw new RagIngestError("The page took too long to read or was too large.");
		}

		const { title, text } = isPlain ? { title: "", text: raw } : await extractReadableHtml(raw, "admin-ingest");
		if (!text.trim()) {
			throw new RagIngestError("No readable text was found at that URL.");
		}
		return { title, text: text.trim(), url };
	} finally {
		clearTimeout(timer);
	}
}
