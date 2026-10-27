// The file a copy edit session saves: every changed message, per language, with the text it was
// changed from so `pnpm i18n:apply` can tell when the source moved on in the meantime.

const EDITS_FORMAT = 'alpha-copy-edits';

interface CopyEdit {
	/** The new message template, `{placeholders}` included. */
	text: string;
	/** The template it replaced, as the catalog had it when the edit was made. */
	original: string;
}

export interface EditsFile {
	format: typeof EDITS_FORMAT;
	version: 1;
	createdAt: string;
	updatedAt: string;
	/** locale → message key → edit */
	edits: Record<string, Record<string, CopyEdit>>;
}

export function emptyEditsFile(now = new Date()): EditsFile {
	const at = now.toISOString();
	return { format: EDITS_FORMAT, version: 1, createdAt: at, updatedAt: at, edits: {} };
}

export function countEdits(file: EditsFile): number {
	return Object.values(file.edits).reduce((n, byKey) => n + Object.keys(byKey).length, 0);
}

/** Parses a file someone loaded; throws a sentence a person can act on when it isn't one of ours. */
export function parseEditsFile(raw: string): EditsFile {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error('That file isn’t JSON, so it can’t be a text edits file.');
	}
	const file = data as Partial<EditsFile>;
	if (
		!file ||
		file.format !== EDITS_FORMAT ||
		file.version !== 1 ||
		typeof file.edits !== 'object' ||
		!file.edits
	) {
		throw new Error('That file isn’t a text edits file saved from this tool.');
	}
	for (const [locale, byKey] of Object.entries(file.edits)) {
		for (const [key, edit] of Object.entries(byKey ?? {})) {
			if (typeof edit?.text !== 'string' || typeof edit?.original !== 'string') {
				throw new Error(`The edit for ${key} (${locale}) is incomplete.`);
			}
		}
	}
	return file as EditsFile;
}

export function suggestedFileName(now = new Date()): string {
	return `alpha-text-edits-${now.toISOString().slice(0, 10)}.json`;
}
