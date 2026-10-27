import { m } from "$lib/paraglide/messages.js";

// Which second-opinion failures are worth retrying, and what to say about the ones that aren't.
//
// Extracted from SecondOpinion.svelte so the decision is testable without mounting the component.
// The component owned it as a single `unavailable` boolean, which meant every failure rendered the
// same cause-neutral sentence with a "Try again" button underneath.
//
// That is wrong for exactly one reason: `not_configured` is PERMANENT. The route returns it when no
// panelist id survives the registered-endpoint filter, and a deployment missing that config cannot
// resolve it by being asked again. Offering a retry there tells the user a config error is a network
// blip, which is what that button produces after a few presses.
//
// The panel's own models are appended by `maybeAddCompareModels` on their own endpoint
// (SECOND_OPINION_BASE_URL + SECOND_OPINION_API_KEY) after `selectAllowedModels` has run, so they
// bypass MODEL_ALLOWLIST by construction. `not_configured` therefore means no panel id is configured,
// or none is registered (for example because SECOND_OPINION_BASE_URL or SECOND_OPINION_API_KEY is
// missing); the allowlist does not cause it.

/** The `reason` field the route sends alongside `available: false`. `null` = we never got one. */
export type SecondOpinionFailure = "not_configured" | "empty" | "error" | null;

/** True when trying again could plausibly produce a different outcome.
 *
 *  `empty` (every panelist missed the deadline) and `error` (route threw, HTTP failed, network
 *  dropped) are genuinely transient. `not_configured` is a deployment fact and cannot resolve
 *  itself. An unknown/absent reason is treated as retryable — the honest default when we don't
 *  know is to let the user try, not to tell them to give up. */
export function isRetryable(reason: SecondOpinionFailure): boolean {
	return reason !== "not_configured";
}

/** User-facing failure copy. Says what did not happen; never speculates about why beyond what the
 *  reason actually establishes. The permanent case must foreclose the retry in words as well as by
 *  hiding the button — a user who has clicked it before will look for it. */
export function failureMessage(reason: SecondOpinionFailure): string {
	if (reason === "not_configured") {
		return m.message_secondOpinionNotConfigured();
	}
	return m.message_secondOpinionUnavailable();
}
