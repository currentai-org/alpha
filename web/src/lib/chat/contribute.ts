/**
 * Where people can pitch in, shared by the Contribute settings page, the composer's language-gap
 * call-to-action and the sidebar's "Get involved" card. "Share a dataset" goes to the Mozilla Data
 * Collective's "Contribute your language" page, which lays out the ways to contribute and pre-fills
 * its dataset search from `utm_term`, matched semantically, so a language code or a name both work.
 * Its upload form sits behind sign-in and a hand-reviewed uploader request. (CUR-3232)
 */

/** Mozilla Data Collective: community-governed datasets, with terms set by whoever shares them. */
export const MOZILLA_DATA_COLLECTIVE = {
	home: 'https://mozilladatacollective.com',
	/** Public landing page for sharing data in a language; `utm_term` pre-fills its dataset search. */
	contributeLanguage: 'https://mozilladatacollective.com/contribute-language',
	datasets: 'https://mozilladatacollective.com/datasets',
	community: 'https://community.mozilladatacollective.com/'
} as const;

/** Mozilla Common Voice: record or validate sentences in your language. */
export const COMMON_VOICE = {
	home: 'https://commonvoice.mozilla.org',
	languages: 'https://commonvoice.mozilla.org/en/languages'
} as const;

/** Apertus, Alpha's main model: open weights and training data from the Swiss AI Initiative. */
export const APERTUS = {
	models: 'https://huggingface.co/swiss-ai',
	report: 'https://github.com/swiss-ai/apertus-tech-report'
} as const;

/** Mistral AI, maker of Mistral Large 3, the default model: its open weights. */
export const MISTRAL = {
	models: 'https://huggingface.co/mistralai'
} as const;
