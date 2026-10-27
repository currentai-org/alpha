/**
 * Language tags for routing. One scheme everywhere in `routing/`: an ISO 639-3 code (what `franc`
 * and the low-resource detector report), optionally followed by a variety subtag for a dialect or
 * regional standard — `cat-valencia`, `por-BR`, `spa-419`. A dialect that has its own ISO code
 * (Swiss German `gsw`, Cantonese `yue`) uses that code and names its parent in `PARENT`.
 *
 * The catalog lists languages as ISO 639-1 (`ca`, `th`); `fromIso1` bridges the two.
 */

/** ISO 639-1 → ISO 639-3, for the codes the catalog uses. */
const ISO1_TO_3: Record<string, string> = {
	en: 'eng',
	de: 'deu',
	fr: 'fra',
	it: 'ita',
	es: 'spa',
	ca: 'cat',
	gl: 'glg',
	eu: 'eus',
	pt: 'por',
	nl: 'nld',
	pl: 'pol',
	id: 'ind',
	ms: 'zlm',
	tl: 'tgl',
	vi: 'vie',
	th: 'tha',
	my: 'mya',
	km: 'khm',
	lo: 'lao',
	ta: 'tam',
	hi: 'hin',
	ar: 'arb',
	ru: 'rus',
	zh: 'cmn',
	ja: 'jpn',
	ko: 'kor',
	sw: 'swh',
	yo: 'yor',
	mi: 'mri',
	fi: 'fin',
	sv: 'swe',
	da: 'dan',
	uk: 'ukr',
	tr: 'tur',
	el: 'ell',
	cs: 'ces',
	ro: 'ron',
	hu: 'hun'
};

export function fromIso1(code: string): string {
	return ISO1_TO_3[code] ?? code;
}

/** 639-3 → 639-1 where one exists, so `Intl.DisplayNames` can name it in the reader's own terms. */
const ISO3_TO_1 = Object.fromEntries(Object.entries(ISO1_TO_3).map(([a, b]) => [b, a]));

/**
 * A dialect or close variety → the language whose support it inherits (at a discount) when a
 * benchmark has no row for it. Quechua varieties fold into Cusco Quechua, the one the low-resource
 * detector reports.
 */
const PARENT: Record<string, string> = {
	gsw: 'deu',
	yue: 'cmn',
	arz: 'arb',
	quy: 'quz',
	qug: 'quz'
};

/** The language a tag belongs to: `cat-valencia` → `cat`, `gsw` → `deu`, `eng` → `eng`. */
export function parentLanguage(tag: string): string | undefined {
	const [base, variety] = tag.split('-');
	if (variety) return base;
	return PARENT[base];
}

/**
 * Names `Intl.DisplayNames` gets wrong or doesn't know (it returns the bare code for several
 * low-resource languages), plus our variety subtags, which aren't BCP 47.
 */
const NAMES: Record<string, string> = {
	und: 'an unclear language',
	quz: 'Quechua',
	quy: 'Quechua (Ayacucho)',
	qug: 'Kichwa',
	yua: 'Yucatec Maya',
	tzh: 'Tzeltal',
	yor: 'Yoruba',
	zlm: 'Malay',
	tgl: 'Tagalog',
	arb: 'Arabic',
	arz: 'Egyptian Arabic',
	cmn: 'Chinese',
	yue: 'Cantonese',
	gsw: 'Swiss German',
	swh: 'Swahili',
	mri: 'Māori',
	pbt: 'Pashto',
	'cat-valencia': 'Valencian',
	'por-BR': 'Brazilian Portuguese',
	'por-PT': 'European Portuguese',
	'spa-419': 'Latin American Spanish',
	'spa-ES': 'Spanish (Spain)',
	'spa-AR': 'Rioplatense Spanish'
};

let displayNames: Intl.DisplayNames | undefined;
function intlName(code: string): string | undefined {
	try {
		displayNames ??= new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
		return displayNames.of(ISO3_TO_1[code] ?? code) ?? undefined;
	} catch {
		return undefined;
	}
}

/** A person-readable English name for a tag. Never the bare code unless nothing else knows it. */
export function languageName(tag: string): string {
	if (NAMES[tag]) return NAMES[tag];
	const [base, variety] = tag.split('-');
	const name = NAMES[base] ?? intlName(base) ?? base.toUpperCase();
	return variety ? `${name} (${variety})` : name;
}

const localDisplayNames = new Map<string, Intl.DisplayNames | null>();
/**
 * `languageName` in the reader's interface language, for screens that are translated. Falls back to
 * the English name where `Intl` doesn't know the language, so a low-resource language is never shown
 * as a bare code.
 */
export function localLanguageName(tag: string, locale: string): string {
	if (locale === 'en' || tag === 'und') return languageName(tag);
	const [base, variety] = tag.split('-');
	if (!localDisplayNames.has(locale)) {
		try {
			localDisplayNames.set(locale, new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }));
		} catch {
			localDisplayNames.set(locale, null);
		}
	}
	const name = localDisplayNames.get(locale)?.of(ISO3_TO_1[base] ?? base);
	if (!name) return languageName(tag);
	const local = name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
	return variety ? `${local} (${variety})` : local;
}

/** The catalog's 639-1 list as tags. `*` (broadly multilingual) passes through. */
export function tagsFromIso1(codes: readonly string[] | undefined): string[] {
	return (codes ?? []).map((c) => (c === '*' ? c : fromIso1(c)));
}
