// Guard-shadow — a MEASURE-ONLY shadow of ONE open guard model
// (Shieldstral-1.0-3B) run next to the live moderation gate. It BLOCKS NOTHING, changes NO decision, and
// is read by NOTHING. Its only outputs are a `[guard-shadow]` log line (latency + fired rule keys), which
// answers two questions in prod: is one DIRECT guard screen faster than the Coop→Zentropi chain, and does
// it AGREE with Zentropi per category. See crisis.ts / moderation.ts.
//
// ── Why this is TRULY shadow (the safety contract the spec pins) ──────────────────────────────────
//   • `launchGuardShadow()` is a SEPARATE fire-and-forget call. The caller MUST NOT join it to the gate
//     promise. It returns void SYNCHRONOUSLY, so a slow / hung / never-settling guard cannot delay the
//     turn, cannot reject the gate, and cannot change any moderation decision.
//   • `guardShadowRun()` ALWAYS resolves and NEVER rejects — a guard error cannot propagate even if a
//     caller awaited it. Defense in depth on top of "don't join it".
//   • OFF by default: NO call is made unless the `guard-shadow` flag is ON *and* GUARD_SHADOW_URL is set.
//   • Logs LABELS ONLY, never the user's text — same posture as `safetyEvents` and the `[moderation]`
//     line (verdict metadata, not content).
//
// ── Data rule ─────────────────────────────────────────────────────────────────
// Only enable this against a no-retention / no-training endpoint, OR scope the rollout to preview
// traffic. NOTE the flag plane is DEPLOYMENT-level (one distinctId, flags.ts) — it can gate by ENV
// (preview vs prod) but CANNOT limit a prod shadow to selected internal users. So in prod this is
// PREVIEW-ONLY unless the endpoint has verified no-retention/no-training terms; a deployment-wide prod
// shadow ships raw user text to a third party and must clear that bar (and a load test) first.
//
// ── Endpoint contract ─────────────────────────────────────────────────────────────────────────────
// GUARD_SHADOW_URL is an OpenAI-compatible base and is the ONLY env var this feature added — the
// token and bill-to reuse the app's existing HF vars (guardGate.ts's env block). Its value now points
// at the Shieldstral chat/completions endpoint (the gate appends /v1/chat/completions). Since the
// guard-primary swap, the shadow runs THE SAME screening operation the sync gate ships —
// runGuardScreen: the screen over the hybrid rules.json (every category query per unit, no umbrella
// gate), full corpus + image coverage — so the agreement/latency it measures is the thing that
// ships, not a look-alike. All config is read at CALL TIME so tests can stub it. Nothing here is
// required until you provide the endpoint — unconfigured ⇒ no-op.

import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger as defaultLogger } from "$lib/chat/server/logger";
import { runGuardScreen, type GuardScreenDeps } from "$lib/chat/server/guardGate";
import {
	makeShieldstralJudge,
	shieldstralConfigured,
	SHIELDSTRAL_MODEL,
} from "$lib/chat/server/detectors/shieldstral";
import { guardInputIsEmpty, type GuardScreenInput } from "$lib/chat/server/guardScreenTypes";

// ── flag gate ───────────────────────────────────────────────────────────────────────────────────────
// The FLAG decides on/off; GUARD_SHADOW_URL is the address (config), never an implied toggle — same
// split as agent mode (CUR-87). Default OFF: a gated experiment defaults closed. Registered in
// flagKeys.ts and pinned by flagKeys.spec.ts.
export const GUARD_SHADOW_FLAG = "guard-shadow";

export function guardShadowEnabled(): boolean {
	return flagEnabledOr(GUARD_SHADOW_FLAG, () => false);
}

export function guardShadowConfigured(): boolean {
	return shieldstralConfigured();
}

// ── result shape ──────────────────────────────────────────────────────────────────────────────────
// `unknown` is NOT `safe`: a non-2xx, an unparseable body, or a missing verdict line all map here, never
// to a clean pass. (Shadow, so it changes nothing — but the discipline matches the live seam.)
export type GuardShadowStatus = "safe" | "unsafe" | "unknown";
export type GuardShadowResult = { status: GuardShadowStatus; categories: string[] };

type MinimalLogger = { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };

export type GuardShadowDeps = {
	fetchImpl?: typeof fetch;
	logger?: MinimalLogger;
	now?: () => number;
	/** Overrides for the flag / config gate (tests). Production reads the flag + env. */
	enabled?: boolean;
	configured?: boolean;
	/** Carried per-turn suppression (guard-swap plan Step 3): the route passes the resolved
	 *  turnPolicy's useGuardPrimary here, so with BOTH flags ON exactly ONE screening operation runs —
	 *  the primary gate's. The shadow must not re-read its own flag to decide this. */
	suppressed?: boolean;
	endpoint?: string;
	token?: string;
	model?: string;
	timeoutMs?: number;
	billTo?: string;
	/** Test seam for the memoized policy, forwarded to runGuardScreen (production loads rules.json). */
	policy?: GuardScreenDeps["policy"];
};

// One guard SCREENING OPERATION (compose, strict verdict ladder) via the shared shipping path. MAY
// reject only if the shared screen itself threw (it never should — runGuardScreen never rejects);
// resolves `unknown` on HTTP/parse/config failure, never a silent `safe`. Kept as the shadow's own
// result shape for log continuity: `unsafe` here means ANY detection (block- or log-action), because
// the shadow's job is agreement measurement, not enforcement — the fired rule KEYS go into the
// [guard-shadow] line for the per-category Axiom joins.
export async function classifyWithGuard(
	input: GuardScreenInput,
	deps: GuardShadowDeps = {}
): Promise<GuardShadowResult> {
	const log = deps.logger;
	// The shadow's adapter config (endpoint/token/bill-to/model/fetchImpl) rides on the injected judge
	// now, not on GuardScreenDeps (coop-review-plane Step 5) — all-undefined overrides read env, exactly
	// as the default judge does.
	const screenDeps: GuardScreenDeps = {
		judge: makeShieldstralJudge({
			fetchImpl: deps.fetchImpl,
			endpoint: deps.endpoint,
			token: deps.token,
			billTo: deps.billTo,
			model: deps.model,
		}),
		timeoutMs: deps.timeoutMs,
		policy: deps.policy,
		// Shadow posture: even the screen's error-level lines (policy load failure) log at WARN here — a
		// shadow failure is not a turn failure and must never page the live-gate alerting.
		logger: log ? { info: log.info, warn: log.warn, error: log.warn } : undefined,
	};
	const screen = await runGuardScreen(input, screenDeps);
	const fired = [...screen.blockHits, ...screen.logHits];
	if (fired.length > 0) return { status: "unsafe", categories: fired.map((r) => r.key) };
	return { status: screen.status === "safe" ? "safe" : "unknown", categories: [] };
}

// Awaitable, ALWAYS-SAFE core: run one classify, log `[guard-shadow]`, and ALWAYS resolve void — never
// reject. This is what makes a guard error un-propagatable regardless of whether a caller awaits it.
export async function guardShadowRun(input: GuardScreenInput, deps: GuardShadowDeps = {}): Promise<void> {
	const log = deps.logger ?? defaultLogger;
	const now = deps.now ?? (() => performance.now());
	let start = 0;
	try {
		start = now();
		const result = await classifyWithGuard(input, deps);
		log.info(
			{
				guardMs: Math.round(now() - start),
				guardStatus: result.status,
				guardCategories: result.categories,
				guardModel: deps.model ?? SHIELDSTRAL_MODEL,
				textLen: input.corpus.length,
				imageUnits: input.images.length,
			},
			"[guard-shadow] shadow screen (NOT enforced)"
		);
	} catch (err) {
		// Discarded: a shadow failure is not a turn failure and must never read as a real moderation
		// failure. Logged at warn (not error) so it doesn't page the live-gate alerting. The inner
		// try/catch means even a clock or logger failure cannot turn this into a rejected promise — the
		// "never rejects" contract holds regardless of what threw.
		try {
			log.warn(
				{
					guardMs: Math.round(now() - start),
					err: err instanceof Error ? err.message : String(err),
				},
				"[guard-shadow] shadow screen failed (discarded)"
			);
		} catch {
			/* swallow — never let logging/clock failure escape as an unhandled rejection */
		}
	}
}

// The route's entry point. FIRE-AND-FORGET by construction: returns void SYNCHRONOUSLY, never throws,
// and detaches the async work. The caller writes `launchGuardShadow(text)` as a bare statement and does
// NOT await or store it — that is the whole safety property. No call is made unless enabled AND
// configured AND there is text to screen.
export function launchGuardShadow(input: GuardScreenInput, deps: GuardShadowDeps = {}): void {
	if (guardInputIsEmpty(input)) return;
	// Suppressed by the carried turn policy: guard-primary already screens this turn through the SAME
	// operation, so a shadow run would be a second, redundant guard call ("both flags ON → exactly one
	// screening operation", guard-swap plan Step 3).
	if (deps.suppressed) return;
	if (!(deps.enabled ?? guardShadowEnabled())) return; // flag off → no guard call
	if (!(deps.configured ?? guardShadowConfigured())) return; // no endpoint → no guard call
	// Detached. guardShadowRun already never rejects; the terminal `.catch` is belt-and-suspenders so
	// that even an unforeseen rejection can never surface as an unhandled promise on the turn.
	void guardShadowRun(input, deps).catch(() => {});
}

// The SINGLE seam the route AND the isolation tests call — this is what makes "shadow beside the gate,
// never in its path" a testable invariant rather than a convention. Launch the shadow, then return the
// gate promise UNCHANGED and on its own timing. The shadow is never awaited or joined here, so:
//   • a hung shadow cannot delay the gate — the returned promise settles when `gate` settles;
//   • a rejecting shadow cannot reject the gate — its rejection is absorbed in launchGuardShadow;
//   • a real gate rejection still propagates — the shadow can never mask it.
// Because the route obtains its gate promise THROUGH this function, a regression that awaits or joins the
// shadow (e.g. `return Promise.all([gate, …])`) makes the never-settling isolation test hang → red.
export function withGuardShadow<T>(gate: Promise<T>, input: GuardScreenInput, deps: GuardShadowDeps = {}): Promise<T> {
	launchGuardShadow(input, deps);
	return gate;
}
