import { sha256 } from "./sha256";

// The browser's own copy of each image it attached, keyed by the hash the server stores it under.
// When a turn ends, the conversation reloads and the message's file comes back as a stored
// reference; drawing that from this copy keeps the thumbnail on screen instead of dropping it,
// showing an empty box and downloading the same photo again (CUR-2761).
//
// The key is computed the way uploadFile.ts names the stored file: sha256 over the bytes read as
// UTF-8 text, which is lossy for binary but deterministic, so the two sides agree.
const MAX_KEPT = 16;
const previews = new Map<string, string>();

async function sentFileKey(base64: string): Promise<string> {
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	return sha256(new TextDecoder().decode(bytes));
}

export async function rememberSentFile(mime: string, base64: string): Promise<void> {
	const key = await sentFileKey(base64);
	previews.delete(key);
	previews.set(key, `data:${mime};base64,${base64}`);
	while (previews.size > MAX_KEPT) {
		const oldest = previews.keys().next().value;
		if (oldest === undefined) break;
		previews.delete(oldest);
	}
}

export function sentFilePreview(hash: string): string | undefined {
	return previews.get(hash);
}
