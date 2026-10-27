// Is Potluck agent mode on? (CUR-87)
//
// ONE answer, read from ONE place. models.ts (whether to register the agent model) and layoutData.ts
// (whether the client renders the toggle) both ask it here: two copies of a boolean are one refactor
// away from a UI that offers a model the registry never registered.
//
// ── The FLAG is the gate; the env narrows it; the URL is config ──────────────────────────────────
// Both `agentModeEnabled()` (deployment-wide registration) and `agentModeEnabledForUser()` (per-user
// access) check `deployEnv()` and then read a PostHog flag. The env check stays in front so the two
// gates stay independently checkable (CUR-771); the flag read makes hiding and restoring the feature
// an operation rather than a deploy (CUR-1440).
//
// A PostHog `getAllFlags()` snapshot can omit a key and so close the gate invisibly (CUR-770). That
// would be a defect for a flag whose job is to hold a feature OPEN; for a
// flag that may hold one SHUT it is the desired direction, and `flagEnabledOr(…, () => false)` fails
// closed on both paths, never polled and polled-with-the-key-absent. A disabled flag and a cold start
// land on the same answer.
//
// ── Two gates, two keys, because they answer different questions ─────────────────────────────────
// `agentModeEnabled()` asks DOES THIS DEPLOYMENT HAVE AGENT MODE — read deployment-wide off the
// getAllFlags() snapshot, with no person attached, because it runs once per instance during registry
// build. `agentModeEnabledForUser()` asks MAY THIS ACCOUNT USE IT — evaluated per-person against
// `AGENT_MODE_ACCESS_FLAG` with the account's real id.
//
// The split is mechanical, not stylistic. A person-scoped release condition on `AGENT_MODE_FLAG`
// would match nobody on the snapshot read AND would stop the agent model registering at all, so the
// per-account question cannot live on that key. And the per-account gate is the whole user-visible
// surface: the agent model registers `unlisted: true`, so the composer's AgentMode toggle
// (layoutData.ts `agentEnabled`) is the only route onto it — narrow this gate and the feature is
// hidden, whether or not the model exists in the registry. Widening registration without this gate
// leaves the toggle invisible even though the model exists (CUR-771).
//
// Which ACCOUNTS are allowed is not written here. It is in the flag's release conditions in PostHog,
// selected by email or by picking people in its UI, so no colleague's id or address lands in this
// repo — see the "Do not rebuild the tester path" note in flags.ts for why that is the requirement
// and not a preference. No per-tester path exists in this file either.
//
// AGENT_SERVICE_URL is the address agent mode calls, NOT a switch: a missing URL on an env this
// function allows is a MISCONFIGURATION, not a silent "off". We say so loudly and withhold agent mode
// (never register a model whose every turn fails at the fetch) rather than let a blank env var
// quietly mask an otherwise-open feature.

import { config } from "$lib/chat/server/config";
import { deployEnv } from "$lib/chat/server/deployEnv";
import { ensureFlagsPolled, flagEnabledForUser, flagEnabledOr } from "$lib/chat/server/flags";
import { flagEmail } from "$lib/chat/server/flagEmail";
import { logger } from "$lib/chat/server/logger";

/** PostHog flag key. Owner: agent-service. Expected to outlive the ACP soak (CUR-44) and then be
 *  removed — a flag nobody removes is worse than no flag. */
export const AGENT_MODE_FLAG = "agent-mode";

/** PostHog flag key for WHICH ACCOUNTS see agent mode, as opposed to whether it exists on this
 *  deployment at all. Owner: chat. A second key rather than a release condition on the one above,
 *  because that one is read deployment-wide with no person attached (CUR-1440). */
export const AGENT_MODE_ACCESS_FLAG = "agent-mode-access";

/** The configured agent service address, or "" — a URL, NOT a feature gate. */
export function agentServiceUrl(): string {
	return ((Reflect.get(config, "AGENT_SERVICE_URL") as string | undefined) ?? "").trim();
}

/** The configured agent service bearer token, or "" when the service's own auth is disabled.
 *  Colocated with agentServiceUrl() for the same reason: one accessor per config key, read from
 *  the same place every caller needs it (models.ts's registry build, the artifact-download proxy
 *  route) instead of each caller doing its own Reflect.get. */
export function agentServiceToken(): string {
	return ((Reflect.get(config, "AGENT_SERVICE_TOKEN") as string | undefined) ?? "").trim();
}

/** Should agent mode be exposed? Sync, never throws. The single gate — see the header. `deployEnv()`
 *  decides on/off (preview and production, default OFF elsewhere); a missing URL on
 *  an allowed env is a loud config error, not a silent toggle. */
export function agentModeEnabled(): boolean {
	const env = deployEnv();
	if (env !== "preview" && env !== "production") return false;
	if (!flagEnabledOr(AGENT_MODE_FLAG, () => false)) return false;
	if (!agentServiceUrl()) {
		logger.warn(
			`[agent] deploy env is ${env} but AGENT_SERVICE_URL is unset — agent mode withheld (config error, not a feature toggle)`
		);
		return false;
	}
	return true;
}

/**
 * May THIS request's user see/run agent mode? Distinct from `agentModeEnabled()`, which is the
 * DEPLOYMENT registration gate ("is the agent available in this env") — this is the PER-USER access
 * gate. The two currently share one answer (both open on preview/production, closed elsewhere). They
 * stay separate named questions so drift between them shows: widening registration without this gate
 * leaves the toggle invisible even though the model is registered (CUR-771).
 *
 * Awaits `ensureFlagsPolled()` before the read, like every other per-request flag consumer
 * (guardGate.ts, models.ts's resolveRegistryGates, grounding.ts, conversation/[id]/+server.ts,
 * endpointOai.ts, folkways-adapter/flag.ts). Vercel Cron only fires on Production, never Preview, and
 * the warm cron is the only other thing that calls `refreshFlags()`, so without it a Preview instance
 * whose first request lands here reads `agent-mode` off an empty cache and silently falls back to
 * `false` (CUR-1572). `agentModeEnabled()` doesn't need this: `modelGates.ts`'s `resolveRegistryGates`
 * calls `refreshFlags()` immediately before it.
 */
export async function agentModeEnabledForUser(locals: App.Locals): Promise<boolean> {
	const env = deployEnv();
	if (env !== "preview" && env !== "production") return false;
	await ensureFlagsPolled();
	if (!flagEnabledOr(AGENT_MODE_FLAG, () => false)) return false;

	// An anonymous visitor has no account to select, so there is nothing PostHog could match. Deny
	// rather than evaluate against a synthetic id: `locals.sessionId` is a cookie the client sends, and
	// feeding that to PostHog as a distinct id is the CUR-1278 defect exactly — a flag answering a
	// question about whoever asked instead of about a person.
	const id = locals.user?._id?.toString();
	if (!id) return false;

	// The real account id, and the email as a person property so the PEOPLE are chosen in the flag's
	// own release conditions rather than listed here. Nothing in this repo needs to know whose account
	// is allowed, which is both the privacy answer and the reason this can't drift out of date.
	const allowed = await flagEnabledForUser(AGENT_MODE_ACCESS_FLAG, id, {
		email: flagEmail(locals.user) ?? "",
		env,
	});

	// `undefined` means PostHog could not answer — unreachable, or the flag does not exist yet. Deny.
	// Denying on an unknown answer is deliberate: allowing would hand the feature to everyone at the
	// exact moment we cannot tell who should have it.
	return allowed === true;
}
