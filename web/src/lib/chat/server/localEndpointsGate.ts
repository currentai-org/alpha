import { deployEnv } from "$lib/chat/server/deployEnv";
import { flagEnabledOr } from "$lib/chat/server/flags";

/** PostHog flag key. Owner: chat. Gates the local (LAN/self-hosted) inference endpoint feature.
 *  Account-scoped: set its release conditions against accounts in PostHog, not against an env. */
export const LOCAL_INFERENCE_FLAG = "local-inference";

/**
 * Is the per-user local (LAN/self-hosted) inference endpoint feature on for this deployment?
 * Sync, never throws.
 *
 * A PostHog flag decides, with `deployEnv()` passed to the evaluation as a person property rather
 * than consulted here (flags.ts evaluates every signed-in request against `env`, `account_id` and
 * `email`). That is the shape every other gate in this tree uses — `guardPrimaryEnabled`,
 * `modelPickerEnabled`, `routerAliasEnabled`, custodial storage — and it is what the repo's
 * flag rules ask for: the flag decides on/off, and an env var is what the feature needs to RUN
 * once it is on.
 *
 * It is a flag rather than a plain `deployEnv() === "preview"` check (CUR-3175): agentMode.ts gates
 * on `deployEnv()` AND polls AGENT_MODE_FLAG. A DB row keyed by user does not replace the flag for
 * per-user targeting: flags.ts passes the properties the database already knows into the evaluation,
 * and the person-selection stays in the flag's release conditions rather than in this repo.
 *
 * The fallback is deliberately not `() => false` like its siblings: a laptop that cannot reach
 * PostHog should still be able to exercise the feature, and `DEPLOY_ENV=development` silently
 * taking local inference away is the failure the fallback prevents. A real deployment
 * with a silent PostHog stays dark.
 */
export function localInferenceEndpointsEnabled(): boolean {
	return flagEnabledOr(LOCAL_INFERENCE_FLAG, () => deployEnv() === "development");
}
