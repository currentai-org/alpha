// Where copy edits leave the browser. Chrome and Edge can keep writing to a file the person picked
// (File System Access API), so every change reaches disk without a step; the handle is kept in
// IndexedDB so a reload can reconnect to the same file. Elsewhere edits are downloaded on request.

import { editsFile, markSaved, onEditsChanged } from './state.svelte';
import { suggestedFileName } from './editsFile';

type Handle = FileSystemFileHandle & {
	queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
	requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
};

type SavePicker = (options: {
	suggestedName: string;
	types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<Handle>;

export const canSaveToFile = () =>
	typeof window !== 'undefined' &&
	typeof (window as { showSaveFilePicker?: SavePicker }).showSaveFilePicker === 'function';

const DB = 'alpha-copy-edit';
const STORE = 'handles';

function db(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function idb<T>(
	mode: IDBTransactionMode,
	run: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	const conn = await db();
	return new Promise((resolve, reject) => {
		const req = run(conn.transaction(STORE, mode).objectStore(STORE));
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

let handle: Handle | undefined;
/** 'none' (no file chosen), 'connected', or 'needs-permission' (after a reload, until a click). */
let status: 'none' | 'connected' | 'needs-permission' = 'none';
const statusListeners = new Set<(s: typeof status) => void>();
function setStatus(s: typeof status) {
	status = s;
	for (const l of statusListeners) l(s);
}
export function onFileStatus(listener: (s: typeof status) => void): () => void {
	statusListeners.add(listener);
	listener(status);
	return () => statusListeners.delete(listener);
}

function serialise(): string {
	return `${JSON.stringify(editsFile(), null, '\t')}\n`;
}

async function write(): Promise<boolean> {
	if (!handle || status !== 'connected') return false;
	try {
		const w = await handle.createWritable();
		await w.write(serialise());
		await w.close();
		markSaved(handle.name);
		return true;
	} catch {
		setStatus('needs-permission');
		return false;
	}
}

let timer: ReturnType<typeof setTimeout> | undefined;
onEditsChanged(() => {
	clearTimeout(timer);
	timer = setTimeout(() => void write(), 300);
});

/** Asks where to save, then writes the current edits there. Must run from a click. */
export async function chooseFile(): Promise<string | undefined> {
	const picker = (window as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
	if (!picker) return undefined;
	try {
		handle = await picker({
			suggestedName: suggestedFileName(),
			types: [{ description: 'Text edits', accept: { 'application/json': ['.json'] } }]
		});
	} catch {
		return undefined; // cancelled
	}
	await idb('readwrite', (s) => s.put(handle, 'file')).catch(() => undefined);
	setStatus('connected');
	await write();
	return handle.name;
}

/** After a reload: finds the file chosen earlier. Writing to it again needs `reconnect()` from a click. */
export async function restoreFile(): Promise<void> {
	if (!canSaveToFile()) return;
	try {
		const stored = (await idb('readonly', (s) => s.get('file'))) as Handle | undefined;
		if (!stored) return;
		handle = stored;
		const state = (await stored.queryPermission?.({ mode: 'readwrite' })) ?? 'prompt';
		setStatus(state === 'granted' ? 'connected' : 'needs-permission');
		if (state === 'granted') await write();
	} catch {
		setStatus('none');
	}
}

/** Re-grants access to the chosen file and writes the edits to it. Must run from a click. */
export async function reconnect(): Promise<boolean> {
	if (!handle) return false;
	const state = (await handle.requestPermission?.({ mode: 'readwrite' })) ?? 'denied';
	if (state !== 'granted') return false;
	setStatus('connected');
	return write();
}

export async function stopUsingFile(): Promise<void> {
	handle = undefined;
	setStatus('none');
	await idb('readwrite', (s) => s.delete('file')).catch(() => undefined);
}

/** Downloads the edits as a file; counts as saved. */
export function download(): void {
	const url = URL.createObjectURL(new Blob([serialise()], { type: 'application/json' }));
	const a = Object.assign(document.createElement('a'), {
		href: url,
		download: suggestedFileName()
	});
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
	markSaved();
}

/** Lets the person pick an edits file to load. Resolves with its text and name, or undefined. */
export function pickFileToLoad(): Promise<{ text: string; name: string } | undefined> {
	return new Promise((resolve) => {
		const input = Object.assign(document.createElement('input'), {
			type: 'file',
			accept: '.json,application/json'
		});
		input.onchange = async () => {
			const f = input.files?.[0];
			resolve(f ? { text: await f.text(), name: f.name } : undefined);
		};
		input.oncancel = () => resolve(undefined);
		input.click();
	});
}
