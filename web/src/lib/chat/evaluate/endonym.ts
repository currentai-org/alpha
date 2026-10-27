import languagesFile from '$lib/chat/server/data/eval/languages.json';

/**
 * A language's name in its own language and script ("français", "العربية", "اردو"), for the
 * language picker. `Intl.DisplayNames` canonicalises most three-letter codes; the few it can't
 * (Southern Pashto) are mapped to the code it knows.
 */
const CANONICAL: Record<string, string> = { pbt: 'ps', arb: 'ar', cmn: 'zh', swh: 'sw', zho: 'zh' };

export function endonym(code: string): string | undefined {
	const tag = CANONICAL[code] ?? code;
	try {
		const name = new Intl.DisplayNames([tag], { type: 'language', fallback: 'none' }).of(tag);
		return name && name !== tag ? name : undefined;
	} catch {
		return undefined;
	}
}

/** Our evaluation language id (`spa`, `spa-ES`) → its BCP 47 tag (`es-419`, `es-ES`), from languages.json. */
const BCP47_BY_ID = new Map(languagesFile.languages.map((l) => [l.id, l.bcp47]));

/** The BCP 47 tag to put in `lang` on text in this language; our ids are not valid tags. */
export function langAttr(code: string): string {
	return BCP47_BY_ID.get(code) ?? CANONICAL[code] ?? code;
}
