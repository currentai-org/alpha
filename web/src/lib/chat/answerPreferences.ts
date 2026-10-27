// The settings that shape how Alpha writes to a person, listed once. The Settings schema,
// the per-turn resolver, every prompt carrier and the Personalization page read this list, so what the
// page shows and what the turn sends cannot disagree (CUR-1443 Done-when 4). No server imports: the
// page bundles it.
//
// Every field is optional on the stored row, and `undefined` means Alpha's default. The default
// assembly of every prompt stays byte-identical to today's, because each clause renders only when the
// person set a value that is not the default (persona.ts `styleFor`, grounding.ts `guardFor`,
// promptSections.ts `answer-style`). There is no feature flag: the change is opt-in per account. (CUR-3929)
import { fromIso1, languageName as tagName } from "$lib/chat/routing/languages";

export const TONES = ["plain", "neutral", "formal"] as const;
export type Tone = (typeof TONES)[number];

export const LENGTHS = ["short", "normal", "detailed"] as const;
export type Length = (typeof LENGTHS)[number];

/** `auto` is the language of the question. The fixed list grows with A2. */
export const ANSWER_LANGUAGES = ["auto", "en", "fr", "de", "es", "it", "pt", "ca", "pl", "ar"] as const;
export type AnswerLanguage = (typeof ANSWER_LANGUAGES)[number];

/** The answer's shape. `auto` is today's rule (each list item on its own line, plain bullets (CUR-549)
 *  preferred); `prose` asks for sentences and paragraphs, `bullets` for a list. */
export const FORMATS = ["auto", "prose", "bullets"] as const;
export type Format = (typeof FORMATS)[number];

/** `never` is today's prompt, which has no emoji rule and gets none; `helpful` adds the one (CUR-549)
 *  clause that permits an emoji where it carries meaning. */
export const EMOJIS = ["never", "helpful"] as const;
export type Emojis = (typeof EMOJIS)[number];

/** Resolved, every field present. What the turn and the page both use. */
export interface AnswerPreferences {
	tone: Tone;
	answerLength: Length;
	/** The existing CUR-1443 field. True is the warmer first-person register (CUR-3930); Alpha never
	 *  claims feelings or humanity either way (persona.ts IDENTITY_HONESTY_INVARIANT). */
	selfReferenceAsPerson: boolean;
	/** Whether an answer may add next steps, offers and questions back. */
	suggestions: boolean;
	/** `auto` is the question's language. A fixed code wins on every prompt path. */
	answerLanguage: AnswerLanguage;
	/** Short sentences, everyday words, no jargon. */
	plainLanguage: boolean;
	/** prose, bullets, or whatever fits (`auto`). (CUR-549) */
	answerFormat: Format;
	/** Never an emoji, or one where it helps. (CUR-549) */
	emojis: Emojis;
	/** Show which model answered and where it ran, under each answer and in X-ray. UI only: (CUR-549)
	 *  no prompt carrier reads it. */
	showServing: boolean;
}

/** Stored: every field optional. `undefined` is Alpha's default. On the wire a write sends `null` to
 *  unset a field (applySettingsUpdate.ts); neither the row nor the client store ever holds `null`. */
export type AnswerPreferencesRow = Partial<AnswerPreferences>;

export const ANSWER_PREFERENCE_KEYS = [
	"tone",
	"answerLength",
	"selfReferenceAsPerson",
	"suggestions",
	"answerLanguage",
	"plainLanguage",
	"answerFormat",
	"emojis",
	"showServing",
] as const satisfies ReadonlyArray<keyof AnswerPreferences>;
export type AnswerPreferenceKey = (typeof ANSWER_PREFERENCE_KEYS)[number];

export const ANSWER_DEFAULTS: Readonly<AnswerPreferences> = Object.freeze({
	tone: "neutral",
	answerLength: "normal",
	selfReferenceAsPerson: false,
	suggestions: true,
	answerLanguage: "auto",
	plainLanguage: false,
	answerFormat: "auto",
	emojis: "never",
	showServing: true,
});

const oneOf = <T extends string>(list: ReadonlyArray<T>, value: unknown, fallback: T): T =>
	typeof value === "string" && (list as ReadonlyArray<string>).includes(value) ? (value as T) : fallback;
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/**
 * The row as the turn and the page use it: every field present, an unset or unknown value replaced
 * by its default. A value outside the list (an old row, a hand edit) is the default too, so no prompt
 * carrier ever sees a word it has no clause for. A stored `explainTerms` (CUR-549, off the page under
 * rule 4.6, CUR-4288) is never read, so an old row's value adds nothing.
 */
export function resolveAnswerPreferences(row: AnswerPreferencesRow | null | undefined): AnswerPreferences {
	return {
		tone: oneOf(TONES, row?.tone, ANSWER_DEFAULTS.tone),
		answerLength: oneOf(LENGTHS, row?.answerLength, ANSWER_DEFAULTS.answerLength),
		selfReferenceAsPerson: bool(row?.selfReferenceAsPerson, ANSWER_DEFAULTS.selfReferenceAsPerson),
		suggestions: bool(row?.suggestions, ANSWER_DEFAULTS.suggestions),
		answerLanguage: oneOf(ANSWER_LANGUAGES, row?.answerLanguage, ANSWER_DEFAULTS.answerLanguage),
		plainLanguage: bool(row?.plainLanguage, ANSWER_DEFAULTS.plainLanguage),
		answerFormat: oneOf(FORMATS, row?.answerFormat, ANSWER_DEFAULTS.answerFormat),
		emojis: oneOf(EMOJIS, row?.emojis, ANSWER_DEFAULTS.emojis),
		showServing: bool(row?.showServing, ANSWER_DEFAULTS.showServing),
	};
}

/** Whether the row leaves this setting to Alpha's default. The store never holds `null` (a reset
 *  sets `undefined` at once and sends `null` on the wire), so `undefined` is the one unset shape. */
export function isDefault(row: AnswerPreferencesRow, key: AnswerPreferenceKey): boolean {
	return row[key] === undefined;
}

/** The fixed answer language's code, or undefined when the answer follows the question (`auto`). */
export function fixedLanguage(prefs: Pick<AnswerPreferences, "answerLanguage">): string | undefined {
	return prefs.answerLanguage === "auto" ? undefined : prefs.answerLanguage;
}

/** An English name for an `ANSWER_LANGUAGES` code, from the routing catalog's own names. */
export function languageName(code: string): string {
	return tagName(fromIso1(code));
}

// One preset sets the voice and the shape in one request. The list below is the ONE list the
// write and the comparison both use, so a preset can neither leave a field to chance nor read as
// active while a field it never set differs. Language, suggestions, self-reference and the serving
// receipt are the person's own and stay as they are. (CUR-549)

/** The fields a preset controls: voice and shape. */
export const PRESET_FIELDS = [
	"tone",
	"answerLength",
	"answerFormat",
	"plainLanguage",
	"emojis",
] as const satisfies ReadonlyArray<AnswerPreferenceKey>;
type PresetField = (typeof PRESET_FIELDS)[number];
/** A preset is complete over `PRESET_FIELDS` and names nothing else. */
export type Preset = Readonly<Pick<AnswerPreferences, PresetField>>;

export const PRESET_NAMES = ["plain", "neutral", "formal", "explanatory"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

function pickPreset(prefs: AnswerPreferences): Preset {
	return Object.freeze({
		tone: prefs.tone,
		answerLength: prefs.answerLength,
		answerFormat: prefs.answerFormat,
		plainLanguage: prefs.plainLanguage,
		emojis: prefs.emojis,
	});
}

export const PRESETS: Readonly<Record<PresetName, Preset>> = Object.freeze({
	plain: Object.freeze({
		tone: "plain",
		answerLength: "short",
		answerFormat: "auto",
		plainLanguage: true,
		emojis: "never",
	}),
	/** Alpha's defaults over the preset fields, derived so the two can never drift. */
	neutral: pickPreset(ANSWER_DEFAULTS),
	formal: Object.freeze({
		tone: "formal",
		answerLength: "normal",
		answerFormat: "prose",
		plainLanguage: false,
		emojis: "never",
	}),
	explanatory: Object.freeze({
		tone: "neutral",
		answerLength: "detailed",
		answerFormat: "auto",
		plainLanguage: false,
		emojis: "never",
	}),
});

/**
 * The preset the resolved preferences match over `PRESET_FIELDS` and nothing else, or `custom`. An
 * unset field counts as its default, so a fresh row reads `neutral`; one later change to any preset
 * field reads `custom`; a change outside the list leaves the preset shown.
 */
export function activePreset(prefs: AnswerPreferences): PresetName | "custom" {
	return PRESET_NAMES.find((name) => PRESET_FIELDS.every((key) => PRESETS[name][key] === prefs[key])) ?? "custom";
}
