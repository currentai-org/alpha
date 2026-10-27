// What the support card (CrisisResources.svelte) says for the visitor's country.
//
// Helplines open, close and change numbers in countries we don't live in, and findahelpline.com (run by
// ThroughLine) already keeps a verified page per country, so the card links that page and this file
// holds no helpline numbers. It holds emergency numbers only, since law fixes those; each cites a source.
//
// The country comes from Vercel's `x-vercel-ip-country` request header, read per request in
// loadChatShellData. It is never stored or logged. (CUR-3912)

/**
 * The country codes findahelpline.com has a page for, from https://findahelpline.com/server-sitemap.xml
 * (181 codes). Each answers 200 at /countries/<code>; `/countries/xx` answers 404, so a
 * code missing here gets the generic card rather than a dead link. To refresh:
 * `curl -s https://findahelpline.com/server-sitemap.xml | rg -o 'countries/[a-z]{2}\b' | sort -u`
 */
const FINDAHELPLINE_COUNTRIES = new Set(
	(
		'ad ae ag al am ar at au aw az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by ca ch ci cl cn ' +
		'co cr cu cv cw cy cz de dj dk dm do dz ec ee es fi fj fo fr ga gb gd ge gf gg gh gi gl gm gp gr ' +
		'gt gu gy hk hn hr ht hu id ie il im in iq ir is it je jm jo jp ke kg kh ki kr kw ky kz la lb lc ' +
		'li lk lr lt lu lv ma mc md me mg mk mm mn mo mq mr mt mu mv mw mx my mz na nc ne ng ni nl no np ' +
		'nr nz om pa pe pg ph pk pl pr ps pt py qa re ro rs ru rw sb sc se sg si sk sl ss sv sz tg th tl ' +
		'tm tn to tr tt tw tz ua ug us uy ve vn vu ws xk ye yt za zm zw'
	).split(' ')
);

// 112 reaches emergency services free of charge in every EU member state, binding under the European
// Electronic Communications Code: https://digital-strategy.ec.europa.eu/en/policies/112
const EU_112 = [
	'at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'de', 'gr', 'hu', 'ie',
	'it', 'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se'
];

const EMERGENCY: Record<string, string> = {
	...Object.fromEntries(EU_112.map((cc) => [cc, '112'])),
	// Switzerland: 112, as listed by Die Dargebotene Hand (143.ch).
	ch: '112',
	// United Kingdom: 999 (https://www.nhs.uk/nhs-services/urgent-and-emergency-care-services/when-to-call-999/).
	gb: '999',
	// United States: 911 (https://www.911.gov).
	us: '911',
	// Canada: 911 (https://988.ca).
	ca: '911'
};

export type CrisisLocale = {
	/** Lower-case ISO 3166-1 alpha-2 code. */
	code: string;
	/** The country's English name, for the link text. */
	name: string;
	/** findahelpline.com's page for the country. */
	helplineUrl: string;
	/** The emergency number, when we hold a sourced one for this country; null means "your local emergency number". */
	emergency: string | null;
};

/** The `x-vercel-ip-country` value as a lower-case code, or null when absent or malformed. */
export function countryFromHeader(value: string | null | undefined): string | null {
	const code = value?.trim();
	return code && /^[A-Za-z]{2}$/.test(code) ? code.toLowerCase() : null;
}

function countryName(code: string): string | null {
	try {
		const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase());
		return name && name.toLowerCase() !== code ? name : null;
	} catch {
		return null;
	}
}

/**
 * The card's country-specific content, or null when the card should stay generic: no country, or one
 * findahelpline has no page for.
 */
export function crisisLocale(country: string | null | undefined): CrisisLocale | null {
	const code = countryFromHeader(country);
	if (!code || !FINDAHELPLINE_COUNTRIES.has(code)) return null;
	const name = countryName(code);
	if (!name) return null;
	return {
		code,
		name,
		helplineUrl: `https://findahelpline.com/countries/${code}`,
		emergency: EMERGENCY[code] ?? null
	};
}
