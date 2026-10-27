// Is multimodal (image in, audio in, file download) on? (CUR-159)
//
// ONE answer, read from ONE place — every seam that blocks a file, an image or a voice clip asks this
// function, so "is multimodal off" has a single truth instead of five independent readings of one env
// var.
//
// ── The FLAG is the gate; MULTIMODAL_ENABLED is config ───────────────────────────────────────────
// The PostHog `multimodal` flag decides on/off. An env var left unset is an absence, not a
// decision anyone made, cannot be rolled out to a fraction of users, and is one unreviewed edit from
// live. Same shape as agentMode.ts's AGENT_SERVICE_URL (CUR-87).
//
// MULTIMODAL_ENABLED survives as the deployment's own consent: the environment stating that it is
// prepared to accept images and audio. Two independent keys, and that is deliberate for this surface
// — the model on the other side genuinely answers image and audio prompts, and nothing in the
// moderation stack looks at either yet (CUR-160). A flag flip alone should not be able to open it.
//
// A missing MULTIMODAL_ENABLED while the flag is ON is therefore a MISCONFIGURATION, not a silent
// "off": the flag opened a feature the deployment has not agreed to serve. Say so LOUDLY and withhold,
// rather than letting a blank env var quietly mask a flagged-on feature.
//
// ── A third gate: the model has to be known to read images (CUR-454) ────────────────────────────
// With both keys open, a model is offered image input only if it is known to read images
// (`toModelConfigs` in modelsCatalog.ts): a catalogued model as the routing catalog's `readsImages`
// records it, any other as its host's `/models` says. A model known to neither stays text-only, so opening
// both keys and seeing no image control means checking the model's entry, not this file.
//
// Fallback is OFF: when PostHog has never been polled (cold start, unreachable at boot, no key) multimodal
// stays off until the flag explicitly opens it. A gated feature defaults closed.
//
// NOT per-user yet. This is the DEPLOYMENT gate. Scoping the re-enable to named testers is the
// re-enable ticket's job and wants `flagEnabledForUser`, the way agentMode.ts does it.

import { config } from "$lib/chat/server/config";
import { guestSignInFlagValues, flagEnabledOr, fuzzOverrideValue } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";

/** PostHog flag key. Owner: trust-and-safety. Expected to be removed once multimodal is either
 *  permanently on or permanently gone — a flag nobody removes keeps a dead branch alive. */
export const MULTIMODAL_FLAG = "multimodal";

/**
 * Has the deployment declared it will serve images and audio? A statement of readiness, NOT the gate.
 * Read via Reflect.get because the key isn't in the committed .env (avoids the ConfigProxy typecheck
 * error on unset keys — same pattern as MODEL_ALLOWLIST).
 */
export function multimodalConfigured(): boolean {
	return (
		String(Reflect.get(config, "MULTIMODAL_ENABLED") ?? "")
			.trim()
			.toLowerCase() === "true"
	);
}

/** Once per process, not once per read. Eight seams call the gate — one of them per chat request and
 *  one per attachment download — so the misconfigured branch is also the CHATTIEST branch, and it is
 *  entered on a PostHog flip nobody redeploys for. A static config fact cannot change between two
 *  reads in the same instance, so repeating it only buries the line that matters. Same shape as flags.ts's
 *  `reportMissingKeys`. Vercel instances are ephemeral, so cold starts re-warn and the signal still
 *  lands in any multi-hour Axiom window. */
let warnedUnconfigured = false;

/** Reset the once-per-process warn latch. TESTS ONLY. */
export function __resetMultimodalWarnForTest(): void {
	warnedUnconfigured = false;
}

/**
 * Should any multimodal surface be open? Sync, never throws. The single gate — see the header. The
 * FLAG decides on/off (default OFF); the flag ON with MULTIMODAL_ENABLED unset is a loud config error,
 * not a silent toggle — loud ONCE, see `warnedUnconfigured`.
 */
export function multimodalEnabled(): boolean {
	if (!flagEnabledOr(MULTIMODAL_FLAG, () => false)) return false;
	if (!multimodalConfigured()) {
		if (!warnedUnconfigured) {
			warnedUnconfigured = true;
			logger.warn(
				"[multimodal] multimodal flag is ON but MULTIMODAL_ENABLED is unset — multimodal withheld (config error, not a feature toggle)"
			);
		}
		return false;
	}
	return true;
}

/**
 * Would signing in open images for this guest? The same flag, evaluated for the guest's own
 * distinct id as a signed-in visitor with no email (CUR-3015), so a team-only rule says no and a rule
 * for everyone signed in, or a percentage, answers for this guest. Asked only when a guest's photo was
 * just refused (`/chat/api/sign-in-hint`), so PostHog sees one request per guest who tries, not one
 * per page load. An answer that has not arrived within `timeoutMs` is no. (CUR-2949)
 */
export async function multimodalOnSignIn(sessionId: string, timeoutMs = 1500): Promise<boolean> {
	if (!multimodalConfigured()) return false;
	// A request that forces the flag (the scenario suite, CUR-3979) gets the forced answer here too, the
	// way `multimodalEnabled` does; PostHog's answer for this guest would contradict the page it is on.
	const forced = fuzzOverrideValue(MULTIMODAL_FLAG);
	if (forced !== undefined) return forced;
	const values = await guestSignInFlagValues(sessionId, timeoutMs);
	return values?.get(MULTIMODAL_FLAG) === true;
}

/**
 * Does `model` take images for THIS request? The model list is built once per server instance, so its
 * `multimodal` field says only that the deployment is prepared to serve images and the model reads them
 * (`multimodalConfigured()` and the catalog). Whether this visitor may send one is the `multimodal`
 * flag, which is evaluated per account and is team accounts only on preview (CUR-2725). Every seam
 * that offers or sends an image asks this, never the model's field alone.
 */
export function modelTakesImagesNow(model: { multimodal?: boolean }): boolean {
	return model.multimodal === true && multimodalEnabled();
}

/**
 * Should THIS turn send image parts to the model? The per-user `multimodalOverrides` setting is a
 * user's past preference, not a statement about what this deployment serves today — and it persists
 * long after the setting that created it. It is therefore ANDed with the deployment gate, which the
 * override path did not previously consult (CUR-159).
 *
 * On HuggingChat the capability comes from the upstream router, so stored overrides are ignored there
 * entirely and existing entries stop applying.
 */
export function resolveForceMultimodal(opts: {
	isHuggingChat: boolean;
	override: boolean | undefined;
}): boolean {
	if (opts.isHuggingChat) return false;
	if (!multimodalEnabled()) return false;
	return Boolean(opts.override);
}
