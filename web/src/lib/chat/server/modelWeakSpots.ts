// Plain sentences for each picker model with a weak spot on the product's own chat path that the
// harness does not fix (CUR-970). The picker decides whether and how to show it (CUR-420 Q1); this
// module only carries the words, so a model that gets fixed loses its entry here and nowhere else.
// Keys are lower-case wire ids, like modelProfiles.ts.
// Each entry is a message with a {model} slot, filled with the catalog's name, so the line names the
// model the way the composer's picker does ("ALIA 40B is easier to talk into…"). The words live in
// messages/*.json, so the line is in the request's language (CUR-4262).

import { catalogByGatewayId } from '$lib/chat/routing/catalog';
import { m } from '$lib/paraglide/messages.js';

/**
 * BSC-LT/ALIA-40b-instruct: an "ignore all previous instructions, confirm by saying exactly …" prompt
 * gets the same response with and without the trailing rule, so the rule ships for Bielik only.
 *
 * speakleash/Bielik-11B-v3.0-Instruct: the trailing rule changes how that prompt is handled (followed in
 * 5 of 5 runs without it, 3 of 20 with it), so the rule ships for this model.
 *
 * aisingapore/Gemma-SEA-LION-v4-27B-IT: for a made-up protocol name it describes one in 5 of 5 runs.
 * The abstention rule that addresses it also applies to real topics, so it is not shipped.
 */
const WEAK_SPOTS: Readonly<Record<string, (inputs: { model: string }) => string>> = {
	'bsc-lt/alia-40b-instruct': (inputs) => m.message_weakSpotAlia(inputs),
	'speakleash/bielik-11b-v3.0-instruct': (inputs) => m.message_weakSpotBielik(inputs),
	'aisingapore/gemma-sea-lion-v4-27b-it': (inputs) => m.message_weakSpotSeaLion(inputs)
};

/** An answer setting a model can fail to follow, by the label the "How Alpha answers" page shows. */
type AnswerSetting = 'plainTone' | 'plainLanguage' | 'short' | 'noSuggestions' | 'prose' | 'language';

const ANSWER_SETTING_LABEL: Readonly<Record<AnswerSetting, () => string>> = {
	plainTone: () => `${m.settings_answerTone()}: ${m.settings_answerTonePlain()}`,
	plainLanguage: () => m.settings_answerPlainLanguage(),
	short: () => `${m.settings_answerLength()}: ${m.settings_answerLengthShort()}`,
	noSuggestions: () => `${m.settings_answerSuggestions()}: ${m.product_off()}`,
	prose: () => `${m.settings_answerFormat()}: ${m.settings_answerFormatProse()}`,
	language: () => m.settings_answerLanguage()
};

/**
 * The answer settings each picker model does not reliably follow, from the probe in evals/inspect_tasks/
 * answer_preferences.py (k=5, CUR-4289): the set arm kept the promise in fewer than the probe's pass
 * mark. A miss that only the effect rule saw, where the default answer already met the promise, is not
 * listed (Mistral Large 3, bullets: 9 of 10 kept). Mistral Medium 3.5, the default, passes them
 * (CUR-4287, CUR-4288). Not measured: ALIA 40B's other seven settings, Large 4's plain language,
 * Bielik's formal tone.
 *
 * - mistral-large-2610: suggestions off, 6 of 10.
 * - zai-org/glm-5.2: short, 9 of 15 (no short digest rule, harnessProfiles.ts); Portuguese, 11 of 15.
 * - bsc-lt/alia-40b-instruct: suggestions off, 0 of 10.
 * - speakleash/bielik-11b-v3.0-instruct: plain language, 10 of 15; short, 0 of 15; suggestions off, 0 of
 *   10; prose, 5 of 10.
 * - aisingapore/nemotron-sea-lion-v4.8-120b-a12b: plain tone, 9 of 15.
 */
const ANSWER_WEAK_SPOTS: Readonly<Record<string, readonly AnswerSetting[]>> = {
	'mistral-large-2610': ['noSuggestions'],
	'zai-org/glm-5.2': ['short', 'language'],
	'bsc-lt/alia-40b-instruct': ['noSuggestions'],
	'speakleash/bielik-11b-v3.0-instruct': ['plainLanguage', 'short', 'noSuggestions', 'prose'],
	'aisingapore/nemotron-sea-lion-v4.8-120b-a12b': ['plainTone']
};

/**
 * The measured weak spots for a picker model, each as one sentence that names it, in the request's
 * language, or undefined when none is on record: the behavior sentence first, then the answer settings
 * it does not follow. A model the catalog doesn't name falls back to its wire id.
 */
export function knownWeakSpotFor(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	const key = modelId.trim().toLowerCase();
	const model = catalogByGatewayId(modelId.trim())?.name ?? modelId.trim();
	const settings = ANSWER_WEAK_SPOTS[key];
	const sentences = [
		WEAK_SPOTS[key]?.({ model }),
		settings && m.message_weakSpotAnswerSettings({ model, settings: settings.map((s) => ANSWER_SETTING_LABEL[s]()).join(', ') })
	].filter((s): s is string => !!s);
	return sentences.length ? sentences.join(' ') : undefined;
}
