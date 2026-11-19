import { flagEnabledOr } from "$lib/chat/server/flags";

// languageFallback.ts's word lists and messages are not reviewed by a speaker of any of its three
// languages, and must not reach users without that sign-off. This flag keeps the fallback
// off real users until the sign-off is given; flipping it on is the assignee's decision.

/** PostHog flag key. Owner: chat.. */
export const LOW_RESOURCE_LANGUAGE_FALLBACK_FLAG = "low-resource-language-fallback";

/**
 * Is the low-resource-language honest-fallback short-circuit (languageFallback.ts) on for this
 * deployment? Sync, never throws. Default-off fallback: when off, a match falls through to the
 * normal generation path.
 */
export function lowResourceLanguageFallbackEnabled(): boolean {
	return flagEnabledOr(LOW_RESOURCE_LANGUAGE_FALLBACK_FLAG, () => false);
}

/** PostHog flag key. Owner: chat.. */
export const LOW_RESOURCE_PER_MODEL_FLAG = "low-resource-per-model";

/**
 * Does a turn name the language the person wrote in when the serving model was measured to
 * drift out of it (harnessProfiles.ts `weakLanguages`; Hausa and Amharic on Apertus)? Off: the generic
 * reply-language sentence only.
 */
export function lowResourcePerModelEnabled(): boolean {
	return flagEnabledOr(LOW_RESOURCE_PER_MODEL_FLAG, () => false);
}
