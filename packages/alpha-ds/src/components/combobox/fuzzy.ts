/**
 * Rank items against what someone typed into a Combobox: a label that starts with the query first,
 * then one with a word that does, then one that contains it, then one whose letters appear in order
 * (`ctln` finds Catalan). Case and accents are ignored, and an item's `keywords` (another name for it,
 * a code) count as well as its label. An empty query keeps every item in its original order.
 */
export type FuzzyItem = { label: string; keywords?: readonly string[] };

const fold = (text: string) =>
	text
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.trim();

function scoreText(text: string, query: string): number {
	const t = fold(text);
	if (t.startsWith(query)) return 4;
	if (t.split(/[\s(),/-]+/).some((word) => word.startsWith(query))) return 3;
	if (t.includes(query)) return 2;
	let at = 0;
	for (const ch of query) {
		at = t.indexOf(ch, at);
		if (at === -1) return 0;
		at += 1;
	}
	return 1;
}

export function fuzzyScore(item: FuzzyItem, query: string): number {
	const q = fold(query);
	if (!q) return 1;
	return Math.max(...[item.label, ...(item.keywords ?? [])].map((text) => scoreText(text, q)));
}

export function fuzzyFilter<T extends FuzzyItem>(items: readonly T[], query: string): T[] {
	return items
		.map((item, index) => ({ item, index, score: fuzzyScore(item, query) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.item);
}
