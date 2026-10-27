import { base } from '$lib/chat/paths';

/**
 * What a storage write route answers with: `message` on a refusal, `warning` on a partial success,
 * `id` for a location a link just created, `path` and `outcome` for a transfer.
 */
type StorageReply = {
	ok: boolean;
	status: number;
	message?: string;
	warning?: string;
	id?: string;
	path?: string;
	outcome?: 'copied' | 'renamed' | 'alreadyThere';
};

/**
 * Send JSON to a `/chat/api/storage/...` route and read its reply. Null means the request never
 * got an answer (offline, aborted), which each caller words differently from a refusal.
 */
export async function sendStorageJson(path: string, method: 'POST' | 'PUT', body: unknown): Promise<StorageReply | null> {
	const res = await fetch(`${base}/api/storage/${path}`, {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	}).catch(() => null);
	if (!res) return null;
	const data = (await res.json().catch(() => ({}))) as Omit<StorageReply, 'ok' | 'status'>;
	return { ...data, ok: res.ok, status: res.status };
}
