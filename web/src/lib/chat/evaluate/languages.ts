import { LAUNCH_LANGUAGES } from '../languageData';
import { languageName } from '../routing/languages';
import type { EvalLanguage } from './types';

/** Evaluation uses Belebele's Mandarin code (`zho`); routing uses `cmn`. */
export function evalLanguageId(id: string): string {
	return id === 'cmn' ? 'zho' : id;
}

/** Names from the evaluation catalog where routing or Intl uses a different name. */
const EVAL_NAMES: Record<string, string> = {
	ben: 'Bengali',
	cmn: 'Mandarin',
	pbt: 'Pashto',
	swh: 'Kiswahili'
};

/** All 26 launch languages, independent of which have answers ready to rate. */
export const EVAL_LANGUAGES: EvalLanguage[] = LAUNCH_LANGUAGES.map<EvalLanguage>((tag) => ({
	id: evalLanguageId(tag),
	name: EVAL_NAMES[tag] ?? languageName(tag),
	dir: tag === 'arb' || tag === 'urd' || tag === 'pbt' ? 'rtl' : 'ltr'
})).sort((a, b) => a.name.localeCompare(b.name, 'en'));

/** Keep the full catalog visible and include any additional languages returned by the service. */
export function evaluationLanguages(available: EvalLanguage[]): EvalLanguage[] {
	const languages = new Map(EVAL_LANGUAGES.map((language) => [language.id, language]));
	for (const language of available) languages.set(language.id, language);
	return [...languages.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
