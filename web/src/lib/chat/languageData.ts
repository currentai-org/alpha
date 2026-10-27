/**
 * What Alpha offers someone who wants to help with data in a language: the partner actions for each
 * language, and how a link to a partner is built. Every surface that asks for data (the composer's
 * language panel, the Contribute page, the note after a "my language" report) reads this file, so
 * changing a partner's categories or landing pages is a data edit here, not a component change.
 *
 * Every language's actions open with Common Voice, the one most people can do: record or write
 * sentences in their language (`commonVoice.ts` picks the recording screen or, for a language Common
 * Voice doesn't take yet, its request form). Sharing an existing dataset through the Mozilla Data
 * Collective follows. The Data Collective has no per-language categories or landing pages here, so every
 * language gets `DEFAULT_LANGUAGE_DATA` after the Common Voice action. Add an entry to `LANGUAGE_DATA`
 * to give one language its own actions, or an empty `actions` list (with `commonVoice: false`) to offer
 * only the "tell us you want to help" form.
 *
 * Kept free of `$lib` aliases so its spec runs under plain Node.
 */
import { commonVoiceLink } from './commonVoice';
import { MOZILLA_DATA_COLLECTIVE } from './contribute';

/** Partner sites a data action can send someone to, with the name the "you're leaving" note uses. */
export const DATA_PARTNERS = {
	'common-voice': { name: 'Common Voice' },
	'mozilla-data-collective': { name: 'Mozilla Data Collective' }
} as const;
type DataPartner = keyof typeof DATA_PARTNERS;

export interface DataAction {
	/** Stable id, reported as `destination` on `mdc_cta_clicked`. */
	id: string;
	/** Button label. `{language}` becomes the language's name. */
	label: string;
	partner: DataPartner;
	/** The partner page, without tracking parameters (`partnerHref` adds those). */
	href: string;
}

export interface LanguageDataEntry {
	/** Partner actions, most relevant first, after the Common Voice action. */
	actions: DataAction[];
	/** Open with the Common Voice action (its recording screen, or its new-language form). Defaults to on. */
	commonVoice?: boolean;
	/**
	 * Offer "tell us you want to help with {language} data", stored per language through
	 * /chat/api/contribute. Defaults to on when there are no actions.
	 */
	interest?: boolean;
}

/** Where in Alpha a data call-to-action was shown. Sent as `surface` on every event and link. */
export type DataSurface =
	| 'composer_language_panel'
	| 'composer_languages_panel'
	| 'contribute_page'
	| 'answer_language_report';

/** Every language until MDC confirms per-language categories. */
export const DEFAULT_LANGUAGE_DATA: LanguageDataEntry = {
	actions: [
		{
			id: 'mdc_share',
			label: 'Share {language} data',
			partner: 'mozilla-data-collective',
			href: MOZILLA_DATA_COLLECTIVE.contributeLanguage
		}
	],
	interest: true
};

/**
 * Per-language entries, keyed by routing tag (ISO 639-3, optionally with a variety: `por-BR`). A
 * variety without its own entry falls back to its base language, then to the default. For example:
 *
 *   yor: { actions: [{ id: 'mdc_yor_text', label: 'Add Yoruba text to an open corpus', partner: 'mozilla-data-collective', href: '…' }] },
 *   quz: { actions: [] }, // no partner project yet: Common Voice, then the interest form
 */
export const LANGUAGE_DATA: Record<string, LanguageDataEntry> = {};

/** The configured entry for a language, before the Common Voice action is added. */
function languageEntryFor(tag: string): LanguageDataEntry {
	return LANGUAGE_DATA[tag] ?? LANGUAGE_DATA[tag.split('-')[0]] ?? DEFAULT_LANGUAGE_DATA;
}

/**
 * The Common Voice action for a language: `cv_speak` to its recording screen, `cv_in_progress` to
 * Common Voice's language list where it shows as in progress, or `cv_request` to the form asking
 * Common Voice to add it. The last two open in the person's interface language.
 */
function commonVoiceAction(tag: string, interfaceLocale?: string): DataAction {
	const link = commonVoiceLink(tag, interfaceLocale);
	const partner = 'common-voice';
	if (link.kind === 'speak') return { id: 'cv_speak', label: 'Help build an open {language} dataset', partner, href: link.href };
	if (link.kind === 'in_progress')
		return { id: 'cv_in_progress', label: 'Help Common Voice get ready for {language}', partner, href: link.href };
	return { id: 'cv_request', label: 'Ask Common Voice to add {language}', partner, href: link.href };
}

/** What a surface offers for a language: the Common Voice action first, then the entry's own. */
export function languageDataFor(tag: string, interfaceLocale?: string): LanguageDataEntry {
	const entry = languageEntryFor(tag);
	if (entry.commonVoice === false) return entry;
	return {
		actions: [commonVoiceAction(tag, interfaceLocale), ...entry.actions],
		// The interest form follows the entry's own actions: Common Voice doesn't stand in for a partner project.
		interest: offersInterest(entry)
	};
}

/** Whether the "tell us you want to help" form shows for an entry. */
export function offersInterest(entry: LanguageDataEntry): boolean {
	return entry.interest ?? entry.actions.length === 0;
}

export function actionLabel(action: DataAction, languageName: string): string {
	return action.label.replaceAll('{language}', languageName);
}

/**
 * A partner link that says where it came from: `utm_source=aipotluck`, the surface the person
 * clicked in (`utm_content`) and the language (`language`, plus `utm_term` so it survives analytics
 * tools that drop unknown parameters). The Data Collective pre-fills its dataset search from
 * `utm_term`, so an unknown language (`und`) sends neither rather than searching for "und".
 */
export function partnerHref(href: string, ctx: { language: string; surface: DataSurface }): string {
	const url = new URL(href);
	url.searchParams.set('utm_source', 'aipotluck');
	url.searchParams.set('utm_medium', 'alpha');
	url.searchParams.set('utm_campaign', 'language_data');
	url.searchParams.set('utm_content', ctx.surface);
	if (ctx.language !== 'und') {
		url.searchParams.set('utm_term', ctx.language);
		url.searchParams.set('language', ctx.language);
	}
	return url.toString();
}

/**
 * The 26 launch languages, as routing tags (Mandarin is `cmn` here, as the language
 * detector reports it). The Contribute page offers these when it doesn't know the person's language.
 */
export const LAUNCH_LANGUAGES = [
	'eng', 'spa', 'por', 'fra', 'deu', 'ita', 'cat', 'eus', 'pol', 'ukr', 'ell', 'ron', 'arb',
	'hin', 'ben', 'urd', 'tam', 'ind', 'vie', 'tgl', 'cmn', 'pbt', 'swh', 'amh', 'yor', 'hau'
] as const;
