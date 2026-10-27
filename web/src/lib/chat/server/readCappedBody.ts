/**
 * Read a response body with a hard byte cap, cancelling the stream the moment it is passed, so a body
 * with no or a lying Content-Length (or a decompression bomb) is never fully buffered. Returns null
 * when the cap is passed; the caller says what that means. Shared by the admin RAG ingest and
 * api/fetch-url (CUR-3191).
 */
export async function readCappedBytes(res: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
	const body = res.body;
	if (!body) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(value);
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* already released */
		}
	}
	const buf = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		buf.set(c, offset);
		offset += c.byteLength;
	}
	return buf;
}
