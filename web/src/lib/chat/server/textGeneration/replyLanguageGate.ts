import { flagEnabledOr } from "$lib/chat/server/flags";

// Gates the in-language reply rule that `guardFor()` injects into the user turn — "write your ENTIRE
// reply in the same language as the message inside the markers above" (CUR-1430).
//
// DEFAULT-ON, and the reasoning is the same as entity-name-correction's rather than
// low-resource-language-fallback's. This flag repairs a defect: replies can come back in English to a question asked in another language. A rollout gate defaulting off
// is precisely the shape flag-class-audit.mjs exists to report. So this is a rollback lever.
//
// WHY THE FLAG MUST NOT BE CREATED WITH A PREVIEW-ONLY RELEASE CONDITION. `flagEnabledOr` falls back
// only when PostHog does not define the key at all; a flag that EXISTS and evaluates false in an
// environment returns false, not the fallback (flags.ts). So creating this with an `env=preview` group
// and no production group would turn the fix OFF in production and ship the defect — the opposite of
// what a default-on fallback implies. Either leave the key uncreated, or create it with a production
// group at 100% alongside the preview one.
//
// The A/B this exists for: set the preview group to 0% for the control arm, back to 100% for the
// treatment arm, and leave production at 100% throughout.

/** PostHog flag key. Owner: chat. See CUR-1430. */
export const REPLY_LANGUAGE_FLAG = "reply-language-rule";

/**
 * Is the in-language reply rule on for this deployment? Sync, never throws.
 *
 * Fallback is ON: with no flag created, every deployment gets the rule, which is the correct resting
 * state for a fix to a live defect. Turning it off restores the pre-CUR-1430 prompt, where the only
 * language instruction was one clause in the system role that read "(default English)".
 */
export function replyLanguageRuleEnabled(): boolean {
	return flagEnabledOr(REPLY_LANGUAGE_FLAG, () => true);
}
