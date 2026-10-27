// Copy edit mode's state: whether it is on, the edits made so far, and whether they have reached a
// file yet. Edits are written to this browser's storage on every change, so a reload or a closed tab
// never loses them; the file is the copy that leaves the browser (see fileSave.ts).
//
// Only reachable on dev and preview builds: production builds resolve `$lib/paraglide/messages.js` to
// Paraglide's own module, never to messagesProxy.ts (vite.config.ts, copyEditMessages).
import { getLocale } from '$lib/paraglide/runtime.js';
import { interpolate, mark } from './markers';
import { countEdits, emptyEditsFile, type EditsFile } from './editsFile';

const STORAGE_KEY = 'alpha:copy-edit';

type Tool = 'edit' | 'browse';

interface Stored {
	on: boolean;
	tool: Tool;
	file: EditsFile;
	/** `revision` as it stood when the edits last reached a file (saved or downloaded). */
	savedRevision: number;
	revision: number;
	/** Name of the file the edits are written to, when one was chosen. */
	fileName?: string;
	/** Whether the person has been through the "where should edits be saved" step. */
	started: boolean;
}

export const copyEdit = $state({
	on: false,
	tool: 'edit' as Tool,
	/** Bumped on every change, so rendered messages re-read their text. */
	version: 0,
	revision: 0,
	savedRevision: 0,
	fileName: undefined as string | undefined,
	started: false,
	count: 0
});

let file: EditsFile = emptyEditsFile();
let keys: string[] = [];
// Lookup tables, never rendered: plain collections on purpose.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
let keyIndex = new Map<string, number>();

/** Called once by messagesProxy.ts with every message key, so tags can carry a short index. */
export function registerKeys(all: string[]): void {
	keys = [...all].sort();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	keyIndex = new Map(keys.map((k, i) => [k, i]));
}

export function keyAt(index: number): string | undefined {
	return keys[index];
}

export function allKeys(): readonly string[] {
	return keys;
}

/**
 * What a message renders while copy edit mode is on: the edited template for the reader's language if
 * there is one, otherwise Paraglide's own output, tagged with the message key. Off, it is Paraglide's
 * output untouched.
 */
export function editedMessage(
	key: string,
	fn: (inputs?: unknown, options?: { locale?: string }) => string,
	inputs?: unknown,
	options?: { locale?: string }
): string {
	if (!copyEdit.on) return fn(inputs, options);
	void copyEdit.version;
	const locale = options?.locale ?? getLocale();
	const edit = file.edits[locale]?.[key];
	const text = edit ? interpolate(edit.text, inputs) : fn(inputs, options);
	const index = keyIndex.get(key);
	return index === undefined ? text : mark(index, text);
}

export function editFor(locale: string, key: string) {
	return file.edits[locale]?.[key];
}

export function editsFile(): EditsFile {
	return file;
}

export function listEdits(): { locale: string; key: string; text: string; original: string }[] {
	return Object.entries(file.edits).flatMap(([locale, byKey]) =>
		Object.entries(byKey).map(([key, e]) => ({ locale, key, ...e }))
	);
}

function read(): Stored | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as Stored) : null;
	} catch {
		return null;
	}
}

function persist(): void {
	const stored: Stored = {
		on: copyEdit.on,
		tool: copyEdit.tool,
		file,
		savedRevision: copyEdit.savedRevision,
		revision: copyEdit.revision,
		fileName: copyEdit.fileName,
		started: copyEdit.started
	};
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
	} catch {
		// Storage full or blocked: the file (when chosen) still receives every change.
	}
}

function changed(): void {
	file.updatedAt = new Date().toISOString();
	copyEdit.revision++;
	copyEdit.version++;
	copyEdit.count = countEdits(file);
	persist();
	for (const listener of listeners) listener();
}

// eslint-disable-next-line svelte/prefer-svelte-reactivity
const listeners = new Set<() => void>();
/** Runs after every change to the edits (fileSave.ts writes the chosen file from here). */
export function onEditsChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Restores the last session in this browser; returns whether edit mode was left on. */
export function restore(): boolean {
	const stored = read();
	if (!stored) return false;
	file = stored.file ?? emptyEditsFile();
	copyEdit.tool = stored.tool ?? 'edit';
	copyEdit.revision = stored.revision ?? 0;
	copyEdit.savedRevision = stored.savedRevision ?? 0;
	copyEdit.fileName = stored.fileName;
	copyEdit.started = stored.started ?? false;
	copyEdit.count = countEdits(file);
	copyEdit.on = stored.on;
	copyEdit.version++;
	return stored.on;
}

export function setOn(on: boolean): void {
	copyEdit.on = on;
	copyEdit.version++;
	persist();
}

export function setTool(tool: Tool): void {
	copyEdit.tool = tool;
	persist();
}

export function markStarted(fileName?: string): void {
	copyEdit.started = true;
	if (fileName) copyEdit.fileName = fileName;
	persist();
}

/** Records that the current edits reached a file. */
export function markSaved(fileName?: string): void {
	copyEdit.savedRevision = copyEdit.revision;
	if (fileName) copyEdit.fileName = fileName;
	persist();
}

export function forgetFile(): void {
	copyEdit.fileName = undefined;
	persist();
}

/** Sets a message's text for one language; the original text clears the edit. */
export function setEdit(locale: string, key: string, text: string, original: string): void {
	const byKey = (file.edits[locale] ??= {});
	if (text === original) delete byKey[key];
	else byKey[key] = { text, original: byKey[key]?.original ?? original };
	if (!Object.keys(byKey).length) delete file.edits[locale];
	changed();
}

export function revertEdit(locale: string, key: string): void {
	delete file.edits[locale]?.[key];
	if (file.edits[locale] && !Object.keys(file.edits[locale]).length) delete file.edits[locale];
	changed();
}

/** Replaces the session's edits with a loaded file's (the file is then the saved copy). */
export function loadFile(loaded: EditsFile, fileName?: string): void {
	file = loaded;
	changed();
	markSaved(fileName);
}

export function discardAll(): void {
	file = emptyEditsFile();
	changed();
	markSaved();
}

/** Whether some edit has not reached a file yet (they are always in this browser's storage). */
export const hasUnsaved = () => copyEdit.revision !== copyEdit.savedRevision;
