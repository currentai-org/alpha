// How My files sends one file. A file under the single-request ceiling goes in one POST to
// /api/storage, as before. A larger one, for an account the `chunked-uploads` flag selects, goes as
// chunks under Vercel's 4.5 MB body cap to /api/storage/chunks, then a finishing POST that has the
// server reassemble it and run every upload check on the whole file. Both paths resolve to the
// response that decides the row, so FilesPanel handles a refusal the same way whichever path ran. (CUR-1780)
import { base } from '$lib/chat/paths';
import { CUSTODIAL_MAX_BYTES_PER_FILE, CUSTODIAL_UPLOAD_CHUNK_BYTES } from '$lib/chat/constants/custodialUpload';

/** `status` 0 means the request never got an answer (offline, aborted). */
export type UploadResult = { status: number; body: string; retryAfter?: number };

function post(url: string, body: FormData | string, onProgress?: (loaded: number) => void): Promise<UploadResult> {
	return new Promise((resolve) => {
		const xhr = new XMLHttpRequest();
		xhr.open('POST', url);
		if (typeof body === 'string') xhr.setRequestHeader('content-type', 'application/json');
		if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded);
		xhr.onload = () =>
			resolve({
				status: xhr.status,
				body: xhr.responseText,
				retryAfter: Number(xhr.getResponseHeader('retry-after')) || undefined,
			});
		xhr.onerror = () => resolve({ status: 0, body: '' });
		xhr.send(body);
	});
}

/**
 * Send `file` to My files. `onProgress` gets a whole percentage of the file's bytes sent.
 * @param chunked whether this account may send a file over the single-request ceiling in chunks
 */
export async function sendUpload(
	file: File,
	fields: { folder: string; location?: string },
	chunked: boolean,
	onProgress: (percent: number) => void,
): Promise<UploadResult> {
	const percent = (sent: number) => onProgress(Math.min(100, Math.round((sent / file.size) * 100)));

	if (!chunked || file.size <= CUSTODIAL_MAX_BYTES_PER_FILE) {
		const form = new FormData();
		form.set('folder', fields.folder);
		form.set('file', file);
		if (fields.location) form.set('location', fields.location);
		return post(`${base}/api/storage`, form, percent);
	}

	// Unique among this account's own uploads, which is all the server asks of it.
	const uploadId = crypto.randomUUID().replaceAll('-', '');
	const chunks = Math.ceil(file.size / CUSTODIAL_UPLOAD_CHUNK_BYTES);
	for (let idx = 0; idx < chunks; idx++) {
		const start = idx * CUSTODIAL_UPLOAD_CHUNK_BYTES;
		const form = new FormData();
		form.set('uploadId', uploadId);
		form.set('idx', String(idx));
		form.set('chunk', file.slice(start, start + CUSTODIAL_UPLOAD_CHUNK_BYTES));
		const sent = await post(`${base}/api/storage/chunks`, form, (loaded) => percent(start + loaded));
		if (sent.status < 200 || sent.status >= 300) return sent;
	}
	return post(
		`${base}/api/storage/chunks/complete`,
		JSON.stringify({
			uploadId,
			chunks,
			size: file.size,
			name: file.name,
			type: file.type,
			folder: fields.folder,
			...(fields.location ? { location: fields.location } : {}),
		}),
	);
}
