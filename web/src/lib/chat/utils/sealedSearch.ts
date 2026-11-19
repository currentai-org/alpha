// Search chats over sealed titles.
//
// The server's search matches the stored title and message text, which a sealed chat keeps empty, so
// it never finds one. Search chats fetches the owner's sealed titles once each time it opens
// (`api/conversations/search/sealed`, at most the newest 500), opens them here with the history key,
// and matches the query against the opened text as the person types. Nothing is fetched or opened per
// keystroke. An opened title is cached in memory by conversation, revision and blob for the keyring's
// epoch, so a second open of the dialog opens only titles that changed, and a key change (another
// account, a sign-out) drops every title the previous key opened.
//
// Message text is not searched in the browser: that would mean fetching and opening every sealed
// message on each open of the dialog. The age reader loads only when a title is first opened.

import type { SealedState } from "$lib/chat/crypto/sealedShape";

/** One row of `api/conversations/search/sealed`: the title still sealed. */
type SealedTitleRow = {
	id: string;
	sealedTitle: string;
	sealedTitleRev?: number;
	updatedAt: string | Date;
	model?: string;
	archived?: boolean;
	tags?: string[];
};

/** A sealed chat with its title opened, in the shape Search chats lists. */
export type OpenedTitle = {
	id: string;
	title: string;
	updatedAt: Date;
	model?: string;
	archived?: boolean;
	tags: string[];
};

type Opener = (
	blob: string,
	conversationId: string,
	rev: number | undefined,
	identity: string
) => Promise<{ text: string; state?: SealedState }>;

const openWithAge: Opener = async (blob, id, rev, identity) =>
	(await import("$lib/chat/crypto/sealedHistory")).openSealedText(blob, "title", id, rev, identity);

/** How many titles open at once: enough to finish the newest 500 in about a second, few enough not
 *  to hold the page. */
const OPEN_BATCH = 25;

const opened = new Map<string, { text: string; state?: SealedState }>();
let openedEpoch = -1;

/**
 * Open each row's title with `identity`, reusing what this tab already opened under the same keyring
 * epoch. A title that does not open is left out: Search chats lists only what it can name.
 */
async function openSealedTitles(
	rows: SealedTitleRow[],
	identity: string,
	epoch: number,
	open: Opener = openWithAge
): Promise<OpenedTitle[]> {
	if (epoch !== openedEpoch) {
		opened.clear();
		openedEpoch = epoch;
	}
	const keyOf = (r: SealedTitleRow) => `${r.id}\n${r.sealedTitleRev}\n${r.sealedTitle}`;
	const missing = rows.filter((r) => !opened.has(keyOf(r)));
	for (let i = 0; i < missing.length; i += OPEN_BATCH) {
		await Promise.all(
			missing.slice(i, i + OPEN_BATCH).map(async (r) => {
				const result = await open(r.sealedTitle, r.id, r.sealedTitleRev, identity).catch(() => ({
					text: "",
					state: "unreadable" as const,
				}));
				if (openedEpoch === epoch) opened.set(keyOf(r), result);
			})
		);
	}
	return rows.flatMap((r) => {
		const hit = opened.get(keyOf(r));
		if (!hit || hit.state || !hit.text.trim()) return [];
		return [
			{
				id: r.id,
				title: hit.text.trim(),
				updatedAt: new Date(r.updatedAt),
				...(r.model ? { model: r.model } : {}),
				...(r.archived ? { archived: true } : {}),
				tags: r.tags ?? [],
			},
		];
	});
}

/** The opened titles containing `text` (lowercase, as Search chats passes it) and carrying every tag. */
export function matchSealedTitles(rows: OpenedTitle[], text: string, tags: string[]): OpenedTitle[] {
	if (!text && !tags.length) return [];
	return rows.filter((r) => tags.every((t) => r.tags.includes(t)) && r.title.toLowerCase().includes(text));
}

/** Fetch the owner's sealed titles and open them. Throws when the list cannot be fetched. */
export async function loadSealedTitles(
	url: string,
	identity: string,
	epoch: number,
	open: Opener = openWithAge
): Promise<OpenedTitle[]> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`sealed title list answered ${res.status}`);
	const { conversations } = (await res.json()) as { conversations: SealedTitleRow[] };
	return openSealedTitles(conversations, identity, epoch, open);
}
