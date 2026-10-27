import { flagEnabledOr } from "$lib/chat/server/flags";

/**
 * PostHog flag key. Owner: chat. Measure-only (CUR-2463): changes nothing a visitor sees. When this
 * request's flag answers include it, hooks/handle.ts sets ACCOUNT_ROLLOUT_PROBE_HEADER on the response,
 * which is how `account-rollout.spec.ts` tells, against a real preview, whether a release condition on
 * a person property reached a signed-in account and stayed away from an anonymous visitor.
 */
export const ACCOUNT_ROLLOUT_PROBE_FLAG = "account-rollout-probe";

export const ACCOUNT_ROLLOUT_PROBE_HEADER = "x-account-rollout-probe";

/** Is the probe on for this request? Sync, never throws; off when PostHog says nothing. */
export function accountRolloutProbeEnabled(): boolean {
	return flagEnabledOr(ACCOUNT_ROLLOUT_PROBE_FLAG, () => false);
}
