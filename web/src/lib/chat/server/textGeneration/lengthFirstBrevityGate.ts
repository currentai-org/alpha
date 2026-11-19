import { flagEnabledOr } from "$lib/chat/server/flags";

// Gates the order of guardFor()'s brevity sentence. Off, the turn reads "Answer concisely by
// default … not a long essay. When your message asks for a specific length or a long document, write
// it at that length, in full." On, the requested length comes first and the "long essay" contrast is
// gone.
//
// With the default order, a request for a long guide can be refused on role-shaped turns, the refusal
// quoting the brevity sentence back as the reason. guardFor wraps every turn, so a rewording risks
// longer short answers; that is why the new order sits behind a flag and can be measured on and off.
//
// The fallback is off, so an uncreated flag leaves the default wording everywhere; a preview can turn it
// on for one browser with the fuzz_override cookie.

/** PostHog flag key. Owner: chat. */
export const LENGTH_FIRST_BREVITY_FLAG = "length-first-brevity";

/** Is the length-first brevity wording on for this request? Sync, never throws. */
export function lengthFirstBrevityEnabled(): boolean {
	return flagEnabledOr(LENGTH_FIRST_BREVITY_FLAG, () => false);
}
