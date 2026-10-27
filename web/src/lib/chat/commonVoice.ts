/**
 * Where to send someone who wants to help build an open dataset in their language on Mozilla Common
 * Voice: straight to the recording screen for a language Common Voice takes contributions in
 * (`/ca/speak` opens in Catalan, with Catalan sentences); to Common Voice's language list for one it
 * lists but can't take contributions in yet (Tagalog), where that language shows as in progress; and
 * otherwise to the form that asks Common Voice to add the language. Common Voice answers 200 for any `/{code}/speak` and shows its "not found" in
 * the browser, so the branch is decided here, against `COMMON_VOICE_LOCALES`.
 *
 * Matching is exact: a language reaches `/speak` only under its own Common Voice locale. Quechua is
 * the case this decides. Alpha reports Cusco Quechua (`quz`), which Common Voice doesn't have; it has
 * a dozen other Quechua varieties under their own codes (`quy` Chanka, `qxp` Puno, …). Sending a Cusco
 * speaker to read Chanka sentences would label their recordings as the wrong variety, so `quz` goes to
 * the request form instead.
 *
 * Kept free of `$lib` aliases so its spec runs under plain Node.
 */
import { COMMON_VOICE_LOCALES, COMMON_VOICE_LOCALES_IN_PROGRESS } from './commonVoiceLocales.generated';

const ORIGIN = 'https://commonvoice.mozilla.org';

/**
 * Routing tag (ISO 639-3) → the Common Voice locale for it, where Common Voice uses a two-letter code
 * or a regional one. A tag missing here is looked up as itself, which covers the many languages
 * Common Voice files under their ISO 639-3 code (`gsw`, `quy`, `yue`).
 */
const TO_COMMON_VOICE: Record<string, string> = {
	abk: 'ab', afr: 'af', amh: 'am', arg: 'an', arb: 'ar', ara: 'ar', asm: 'as', azj: 'az', aze: 'az',
	bak: 'ba', bel: 'be', bul: 'bg', ben: 'bn', bre: 'br', cat: 'ca', ces: 'cs', chv: 'cv', cym: 'cy',
	dan: 'da', deu: 'de', div: 'dv', ewe: 'ee', ell: 'el', eng: 'en', epo: 'eo', spa: 'es', est: 'et',
	ekk: 'et', eus: 'eu', fas: 'fa', pes: 'fa', fin: 'fi', fra: 'fr', fry: 'fy-NL', gle: 'ga-IE',
	glg: 'gl', grn: 'gn', gug: 'gn', glv: 'gv', hau: 'ha', heb: 'he', hin: 'hi', hrv: 'hr', hat: 'ht',
	hun: 'hu', hye: 'hy-AM', ina: 'ia', ind: 'id', ibo: 'ig', isl: 'is', ita: 'it', jpn: 'ja', kat: 'ka',
	kaz: 'kk', khm: 'km', kor: 'ko', cor: 'kw', kir: 'ky', lug: 'lg', lao: 'lo', lit: 'lt', lav: 'lv',
	lvs: 'lv', mkd: 'mk', mal: 'ml', mon: 'mn', khk: 'mn', mar: 'mr', msa: 'ms', zsm: 'ms', zlm: 'ms',
	mlt: 'mt', nob: 'nb-NO', npi: 'ne-NP', nep: 'ne-NP', nld: 'nl', nno: 'nn-NO', nbl: 'nr', oci: 'oc',
	orm: 'om', gaz: 'om', ory: 'or', ori: 'or', oss: 'os', pan: 'pa-IN', pol: 'pl', pus: 'ps',
	pbt: 'ps', por: 'pt', ron: 'ro', rus: 'ru', kin: 'rw', srd: 'sc', snd: 'sd', slk: 'sk', slv: 'sl',
	sqi: 'sq', als: 'sq', srp: 'sr', ssw: 'ss', sot: 'st', swe: 'sv-SE', swa: 'sw', swh: 'sw',
	tam: 'ta', tel: 'te', tgk: 'tg', tha: 'th',
	tgl: 'tl', tir: 'ti', tuk: 'tk', tsn: 'tn', tur: 'tr', tso: 'ts',
	tat: 'tt', twi: 'tw', uig: 'ug', ukr: 'uk', urd: 'ur', uzb: 'uz', uzn: 'uz', ven: 've', vie: 'vi',
	xho: 'xh', yid: 'yi', yor: 'yo', zul: 'zu', cmn: 'zh-CN', nan: 'nan-tw'
};

function toCommonVoice(tag: string): string {
	const base = tag.split('-')[0];
	return TO_COMMON_VOICE[base] ?? base;
}

/** The Common Voice locale a routing tag records under, if Common Voice takes contributions in it. */
function commonVoiceLocale(tag: string): string | undefined {
	const locale = toCommonVoice(tag);
	return COMMON_VOICE_LOCALES.has(locale) ? locale : undefined;
}

/** Common Voice's own interface languages that Alpha's interface languages map onto. */
const INTERFACE_LOCALES = new Set(['en', 'es', 'fr', 'de']);

export type CommonVoiceLink =
	| { kind: 'speak'; locale: string; href: string }
	| { kind: 'in_progress'; locale: string; href: string }
	| { kind: 'request'; href: string };

/**
 * The Common Voice page for a language: its recording screen when Common Voice takes it, else the
 * new-language request form, shown in the person's interface language (`es` → `/es/language/request`).
 */
export function commonVoiceLink(tag: string, interfaceLocale = 'en'): CommonVoiceLink {
	const locale = commonVoiceLocale(tag);
	if (locale) return { kind: 'speak', locale, href: `${ORIGIN}/${locale}/speak` };
	const ui = INTERFACE_LOCALES.has(interfaceLocale) ? interfaceLocale : 'en';
	const listed = toCommonVoice(tag);
	if (COMMON_VOICE_LOCALES_IN_PROGRESS.has(listed))
		return { kind: 'in_progress', locale: listed, href: `${ORIGIN}/${ui}/languages` };
	return { kind: 'request', href: `${ORIGIN}/${ui}/language/request` };
}

/** Common Voice's list of every language, in the person's interface language, for when none is picked. */
export function commonVoiceLanguagesHref(interfaceLocale = 'en'): string {
	const ui = INTERFACE_LOCALES.has(interfaceLocale) ? interfaceLocale : 'en';
	return `${ORIGIN}/${ui}/languages`;
}
