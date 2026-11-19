/**
 * Chat tag names and ids, shared by the server and the browser so both read a typed name,
 * and a `tag:` search term, the same way.
 *
 * A tag's id is its name lowercased with each space an underscore, Open WebUI's own rule, so an
 * imported tag and one typed here meet on the same id.
 */

/** Longest tag name kept; longer input is cut. */
export const TAG_NAME_MAX = 40;
/** Most tags one chat may carry. */
export const TAGS_PER_CHAT_MAX = 20;

export interface ChatTag {
	id: string;
	name: string;
}

/** The name as typed, whitespace runs collapsed and cut to {@link TAG_NAME_MAX}; null when nothing is left. */
export function cleanTagName(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const name = raw.replace(/\s+/g, " ").trim().slice(0, TAG_NAME_MAX).trim();
	return name || null;
}

/** Open WebUI's tag id for a name: lowercased, each space an underscore. */
export function tagIdFor(name: string): string {
	return name.replace(/ /g, "_").toLowerCase();
}

/** Cleaned, one per id, in the order given, at most {@link TAGS_PER_CHAT_MAX}. */
export function normalizeTagNames(names: readonly unknown[]): ChatTag[] {
	const out = new Map<string, ChatTag>();
	for (const raw of names) {
		const name = cleanTagName(raw);
		if (!name) continue;
		const id = tagIdFor(name);
		if (!out.has(id)) out.set(id, { id, name });
		if (out.size === TAGS_PER_CHAT_MAX) break;
	}
	return [...out.values()];
}

/**
 * Splits a search query into its `tag:` terms, as tag ids, and the words left over. A term is
 * `tag:grant`, or `tag:"teaching notes"` for a name with a space; `tag:teaching_notes` names the same tag.
 */
export function parseTagQuery(query: string): { text: string; tags: string[] } {
	const tags = new Set<string>();
	const text = query
		.replace(/(^|\s)tag:(?:"([^"]*)"|(\S+))/gi, (_all, lead: string, quoted?: string, bare?: string) => {
			const name = cleanTagName(quoted ?? bare);
			if (name) tags.add(tagIdFor(name));
			return lead;
		})
		.replace(/\s+/g, " ")
		.trim();
	return { text, tags: [...tags] };
}
