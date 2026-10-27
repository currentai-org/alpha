// Folkways adapter — feature flag, read at REQUEST time.
//
// PostHog is THE gate for every route in this folder, same pattern as every other gate module
// under $lib/chat/server (see flags.ts header, states 1-3, and
// storage/custodialStorageGate.ts for the closest precedent). `flagEnabledOr` reads a snapshot
// refreshed by the warm cron, so a call here is a sync map lookup, not a network round trip —
// the "read at request time" property this file always had is unchanged, it just now also
// tracks PostHog instead of only env.
//
// FOLKWAYS_ENABLED is the FALLBACK, used only in the two states flags.ts calls out: PostHog has
// never been polled successfully (no key, PostHog down at boot, cold start), or PostHog was
// polled but does not define this key. In both cases this is exactly today's behavior — an
// unconfigured/not-yet-created flag leaves the adapter exactly as dark as before PostHog existed
// for it. Once PostHog HAS defined the key, its value wins, including the "polled once then
// PostHog became unreachable" state, where the LAST KNOWN value stands rather than reverting to
// env while PostHog is unreachable (flags.ts state 2).
//
// Unset or "0" -> every route in this folder 404s, as if it doesn't exist. Anything else -> live,
// as the fallback. This is the fallback string parsing.
//
// ROLLOUT PERCENTAGE WARNING: this is a DEPLOYMENT-plane gate, evaluated against
// DEPLOYMENT_DISTINCT_ID — a single FIXED distinctId, not one per visitor (flags.ts). A
// percentage rollout condition on this flag key would not distribute traffic; it would pin the
// whole deployment to whichever side of the percentage that one fixed id happens to land on, the
// same on every poll. Only 0% or 100% (or a targeting condition PostHog can actually evaluate
// against that fixed id, e.g. env) make sense here.
//
// FOLKWAYS_MODE selects the adapter's behavior. "observe" is the only mode this
// file adds; anything else (unset, "resolve", "rewrite", ...) keeps the pre-existing resolve +
// rewrite behavior in v1/chat/completions/+server.ts. It stays config, not a flag: it is not a
// rollout/visibility switch, it selects which of two already-shipped behaviors runs.
import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { ensureFlagsPolled, flagEnabledOr } from '$lib/chat/server/flags';

/** PostHog flag key. Owner: chat. Gates every route under /folkways-adapter (v1/chat/completions,
 *  v1/models, v1/safety) — the Folkways control-plane adapter itself. */
export const FOLKWAYS_ADAPTER_FLAG = 'folkways-adapter';

function folkwaysEnabledFallback(): boolean {
	const v = (env.FOLKWAYS_ENABLED ?? '0').trim();
	return v !== '' && v !== '0';
}

async function folkwaysEnabled(): Promise<boolean> {
	// Vercel Cron (the warm leg that refreshes the flag snapshot) runs on Production only, never
	// Preview, and this adapter's routes only ever run on preview/develop, as with guardGate.ts
	// (CUR-1111). Reading flagEnabledOr() bare leaves a cold instance on the env fallback until its
	// first unrelated flag read happens to poll: a snapshot that never gets its first poll never
	// carries the key, so the "polled but key absent" state this fallback exists for is never reached.
	// FOLKWAYS_ENABLED=1 (preview only) narrows this window but doesn't close it: it says nothing about
	// develop's own branch-scoped env, and every cold start still races a warm cron that never runs on
	// this environment. Poll on demand instead, same as resolveRegistryGates() and resolveTurnPolicy().
	await ensureFlagsPolled();
	return flagEnabledOr(FOLKWAYS_ADAPTER_FLAG, folkwaysEnabledFallback);
}

export function folkwaysMode(): 'observe' | 'resolve' {
	return (env.FOLKWAYS_MODE ?? '').trim().toLowerCase() === 'observe' ? 'observe' : 'resolve';
}

/**
 * The answer an AUTHORIZED caller gets when the flag is off: the route exists and we turned it off.
 *
 * Not a bare 404 ("a disabled adapter looks like no adapter"), because the caller a 404 blinds is our
 * own host (CUR-1626). `fetchModelCatalog` cannot tell a deliberate off-switch from a wrong base URL:
 * it reads a 404 as the primary being unreachable and fails over to a catalogue whose ids the
 * allowlist cannot match, leaving the instance serving an empty model registry (CUR-1246). An
 * anonymous caller never sees this answer: adapterGate refuses it before the flag is read.
 *
 * 503 rather than 404 because the route is there. The header is the part a machine should read: a
 * status code alone cannot carry "off on purpose" versus "genuinely unreachable", which is the
 * distinction the host's failover needs and the reason this response exists at all.
 */
const disabledResponse = (): Response =>
	new Response(
		JSON.stringify({
			error: {
				message: `The Folkways adapter is deliberately disabled. This route exists; the "${FOLKWAYS_ADAPTER_FLAG}" flag is off for this deployment. This is a configuration state, not an outage and not a missing path — do not fail over on it.`,
				type: 'folkways_adapter_disabled',
				flag: FOLKWAYS_ADAPTER_FLAG
			}
		}),
		{
			status: 503,
			headers: {
				'content-type': 'application/json',
				'x-folkways-disabled': FOLKWAYS_ADAPTER_FLAG
			}
		}
	);

// Caller auth on the host-to-adapter hop. The host already sends `Authorization: Bearer
// <OPENAI_API_KEY>` to whatever OPENAI_BASE_URL names (endpoints/openai/endpointOai.ts), so the
// same key is the adapter password — no second secret to mint or rotate. Without this check the
// adapter is an open relay: any caller on the internet reaches the upstream with the org's key.
// Unset key → every caller is refused.

/** True when `header` is exactly `Bearer <expected>`, compared in constant time. */
function bearerMatches(header: string | null, expected: string | undefined): boolean {
	if (!expected || !header?.startsWith('Bearer ')) return false;
	const got = Buffer.from(header.slice('Bearer '.length));
	const want = Buffer.from(expected);
	return got.length === want.length && timingSafeEqual(got, want);
}

function callerAuthorized(request: Request): boolean {
	return bearerMatches(request.headers.get('authorization'), env.OPENAI_API_KEY);
}

/**
 * Caller auth for the Mistral route (CUR-3186). Chat reaches this route only as its router lane
 * (`mistralChatLane` in `$lib/chat/server/mistralKey.ts` uses MISTRAL_CHAT_BASE_URL only with
 * MISTRAL_CHAT_API_KEY), so that key is the one bearer chat ever sends here, and the route forwards
 * it upstream. Accepting nothing else keeps the route from relaying anyone else's key or posting
 * their traces to Folkways, and from carrying La Plateforme's own key (CUR-3193).
 */
export function mistralCallerAuthorized(request: Request): boolean {
	return bearerMatches(request.headers.get('authorization'), env.MISTRAL_CHAT_API_KEY?.trim());
}

/** 401 with no body: the route exists, the caller is not the host. Call right after
 *  folkwaysEnabled() in every exported handler in this folder. */
const unauthorizedResponse = (): Response => new Response(null, { status: 401 });

/**
 * Both gates, in the order that keeps each honest. Returns the Response to send, or null to proceed.
 *
 * Auth runs FIRST (CUR-1626). A caller with a bad key gets 401 whatever the flag says, so the flag's
 * state is no longer readable from outside — which is what the original 404 was trying to buy and
 * never did. A caller with the right key is only ever us, and gets told plainly which of the two
 * states it is in.
 *
 * 401 stays 401 for a bad key rather than folding into the disabled response: collapsing those two
 * would reintroduce this exact defect pointed the other way, making our own credential
 * misconfiguration indistinguishable from a route that is switched off.
 *
 * Exists as one function rather than two lines repeated in four handlers because the ORDER is the
 * fix, and an order repeated four times is an order that drifts. It is also the only gate symbol this
 * module exports: the four pieces it composes are module-local and the tests drive them through
 * here — which asserts what a route actually answers rather than what a helper returns.
 */
export async function adapterGate(
	request: Request,
	authorized: (request: Request) => boolean = callerAuthorized
): Promise<Response | null> {
	if (!authorized(request)) return unauthorizedResponse();
	if (!(await folkwaysEnabled())) return disabledResponse();
	return null;
}
