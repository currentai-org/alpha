import { deployEnv } from "$lib/chat/server/deployEnv";
import { flagEnabledForUser, flagEnabledOr } from "$lib/chat/server/flags";

// CUR-899 built the custodial storage server module; CUR-1276 builds its front door. This gate is
// what stands in front of both.
//
// WHY THIS IS PER-USER AND ASYNC
//
// `flagEnabledOr` is the DEPLOYMENT-level primitive: sync, off one fixed distinctId and a polled
// snapshot. That is the wrong shape for this feature: a surface that writes real files into a bucket
// held by ONE shared credential should reach named testers first, not every visitor on an
// environment at once (CUR-1276).
//
// So this gate uses `flagEnabledForUser` (flags.ts, CUR-121): a live per-person evaluation whose answer
// is decided by the account id, with the release condition set in PostHog's own flag UI rather than
// in code. Nothing here needs to change to add or remove a tester.
//
// THE ID IS THE ACCOUNT ID, AND THAT IS THE WHOLE POINT
//
// `accountId` must be `locals.user._id` — the 24-hex account id, never anything the client supplies.
// It is the hash input PostHog decides the answer from, so an id built from a visitor-supplied
// string makes the flag answer a question about a CLAIM rather than about a PERSON. flags.ts keeps a
// note on this so a per-person gate is not built on a visitor-supplied id (CUR-1278).
//
// WHY IT FAILS CLOSED
//
// `flagEnabledForUser` returns `undefined` when it could not evaluate — no PostHog client, or the
// read threw — and deliberately leaves the fallback to the caller, because "not evaluated" is not
// "off". Here the fallback is off. A new, not-yet-trusted surface sitting on a shared credential
// that holds every person's files is the wrong place to fail open, and the cost of failing closed is
// that a tester sees the feature disappear while PostHog is unreachable. That trade is not close.
//
// Note the asymmetry with the deployment-level path this replaced: `flagEnabledOr` goes STALE when
// PostHog is unreachable (last known value) rather than dark. Per-user evaluation has no snapshot to go stale from,
// so dark is the only available failure mode, not a preference.

/** PostHog flag key. Owner: chat. Gates the custodial storage surface (list/upload/download/delete
 *  against the shared HF bucket). Person-scoped: set its release condition against specific account
 *  ids in PostHog, not against an environment. */
export const CUSTODIAL_STORAGE_VIEW_FLAG = "custodial-storage-view";

/**
 * Is the custodial storage surface on for THIS person? Async — a live PostHog read, so it is not for
 * a hot path; every caller here is already doing bucket I/O and a network round-trip is in the noise.
 *
 * @param accountId `locals.user._id` as a string. Never a client-supplied value.
 * @returns `true` only when PostHog said so. An unevaluable flag is `false`, not "probably fine".
 */
export async function custodialStorageViewEnabledForUser(accountId: string): Promise<boolean> {
	// `?? "unknown"` because deployEnv() is nullable and personProperties is not: an unconfigured
	// environment must still evaluate, against a property value that plainly reads as "we could not
	// tell" rather than silently matching a real env name in some release condition.
	const enabled = await flagEnabledForUser(CUSTODIAL_STORAGE_VIEW_FLAG, accountId, {
		env: deployEnv() ?? "unknown",
	});
	return enabled === true;
}

/**
 * Is a guest's chat attachment kept in the bucket (CUR-2183)? The same flag, read at deployment level
 * rather than per person: a guest's id is a hash of a cookie the visitor holds, the client-held
 * value the section above rules out as a per-person hash input. On in preview and off in production
 * for an anonymous visitor today. Off until the first flag poll succeeds; after that, an unreachable PostHog
 * keeps the last value read. Because this reads the deployment-level value, a production condition
 * that enables the flag for everyone also keeps every guest's attachments; one scoped to accounts
 * does not.
 */
export function custodialStorageForGuestsEnabled(): boolean {
	return flagEnabledOr(CUSTODIAL_STORAGE_VIEW_FLAG, () => false);
}
