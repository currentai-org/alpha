import { flagEnabledOr } from "$lib/chat/server/flags";

// Gates the order of guardFor()'s brevity sentence (CUR-2126). Off, the turn reads "Answer concisely by
// default … not a long essay. When your message asks for a specific length or a long document, write
// it at that length, in full." On, the requested length comes first and the "long essay" contrast is
// gone.
//
// Why: with the current order, a request for a long guide can be refused on role-shaped turns, the
// refusal quoting the brevity sentence back as the reason. guardFor wraps
// every turn, so a rewording risks longer short answers; that is why it sits behind a flag and is
// measured on and off rather than shipped outright.
//
// The fallback is off, so an uncreated flag leaves the current wording everywhere; the preview A/B uses
// the fuzz_override cookie. Production enablement is tracked in CUR-2127.

/** PostHog flag key. Owner: chat. See CUR-2126. */
export const LENGTH_FIRST_BREVITY_FLAG = "length-first-brevity";

/** Is the length-first brevity wording on for this request? Sync, never throws. */
export function lengthFirstBrevityEnabled(): boolean {
	return flagEnabledOr(LENGTH_FIRST_BREVITY_FLAG, () => false);
}
