// What My files can show in place, decided by extension. The file endpoint always answers
// application/octet-stream as an attachment (storage/file/+server.ts says why), so the browser is
// never told a type by us. The bytes are fetched, given a type here, and drawn as an <img> or as
// text: an <img> runs no script whatever it holds, and text goes in as textContent. SVG and HTML are
// deliberately absent, since either could run in a context that does. (CUR-3289)

const IMAGE_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
};
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json', 'log']);

/** Images above this are not fetched just to draw a 40px thumbnail. */
export const THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024;
/** How much of a text file the preview shows. */
export const TEXT_PREVIEW_BYTES = 64 * 1024;

export type PreviewKind = { kind: 'image'; type: string } | { kind: 'text' } | { kind: 'none' };

export function previewKind(name: string): PreviewKind {
	const ext = name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : '';
	if (IMAGE_TYPES[ext]) return { kind: 'image', type: IMAGE_TYPES[ext] };
	if (TEXT_EXTENSIONS.has(ext)) return { kind: 'text' };
	return { kind: 'none' };
}

/** Fetch a stored file's bytes and type them for an <img>, or null when that fails. */
export async function imageObjectUrl(fileUrl: string, type: string, signal?: AbortSignal): Promise<string | null> {
	const res = await fetch(fileUrl, { signal }).catch(() => null);
	if (!res?.ok) return null;
	const bytes = await res.arrayBuffer().catch(() => null);
	return bytes ? URL.createObjectURL(new Blob([bytes], { type })) : null;
}
