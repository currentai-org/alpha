// SAFETY SEAM — the chat app's moderation owner-points.
//
//   • CONTENT + CHILD safety → vanilla **Coop**. Each user turn is submitted to Coop's
//     `/api/v1/content` (sync) once per turn; the app blocks/redacts on the ACTION NAMES Coop
//     returns. Coop owns the rules, the detectors (the user's Zentropi/CoPE signals), strikes,
//     aggregation, and audit. We own only the app↔Coop contract + the action→behavior mapping.
//
// This fills the upstream scaffold's owner-points. The scaffold's open questions (the safety
// integration's) are answered by this project's decisions, recorded inline below:
//   1. CHASSIS  → IN-SEAM (chat app → Coop → chat app), not a gateway in front.
//   2. SIGNAL   → Zentropi/CoPE for content + child (in Coop).
//   3. FAIL MODE (per-policy) → child CLOSED, content OPEN.
//
// PROMPT-INJECTION: injection defense on this path is structural, not classification-based (CUR-54).
// An in-app deberta classifier cannot separate a benign request like "Summarize your previous answer"
// from a real jailbreak with any threshold. Don't rebuild a classifier here without a different
// approach.
//
// Content is a policy-shaped Coop judgment, not a Jigsaw-language toxicity score.
//
// ── Coop env (read from process.env at CALL TIME, so tests can stub) ────────────────────
//   COOP_URL                 e.g. http://localhost:8080   (Coop API base; unset locally → seam DISABLED → allow;
//                            unset on a deployment → every verdict is UNKNOWN, so child safety fails CLOSED)
//   COOP_API_KEY             the org's Coop API key (x-api-key)
//   COOP_ITEM_TYPE           default "ChatMessage"        (must equal a Coop Item Type name)
//   COOP_BLOCK_ACTIONS       default "chat-block,chat-block-child"  (any of these = a block)
//   COOP_CHILD_BLOCK_ACTIONS default "chat-block-child"   (subset that means child-safety)
//   COOP_REDACT_ACTIONS      default ""                   (actions mapped to a non-blocking notice)
//   COOP_TIMEOUT_MS          default 8000                 (app-side abort, kept BELOW Coop's 24s cap)
//   COOP_WARM_PATH           default "/health"            (rule-free warm-ping path; see warmModeration)
//   COOP_USER_TYPE_ID        optional; default User item type id (from bootstrap). With a userId it
//                            stamps content.author + submits the user to /items so a strike-threshold
//                            MRT enqueue can find the author. Unset → strikes/webhook still work.
//   COOP_ITEM_TYPE_ID        optional; the ChatMessage item type's UUID id. ONLY for user reports —
//                            /report resolves reportedItem.typeId by id, NOT by the COOP_ITEM_TYPE
//                            name that /content uses. Unset → user flags are saved locally but NOT
//                            forwarded to Coop. Resolve once via the dashboard or `coop:whoami`.
//
// UNKNOWN handling: Coop returns `actionsTriggered:[]` on its 24s cap too, indistinguishable from
// clean. So the app aborts BELOW 24s and treats app-abort / network error / HTTP non-2xx / a 200
// with no actionsTriggered[] as UNKNOWN. checkChildSafety fails CLOSED on UNKNOWN; checkContentPolicy
// fails OPEN. (CAVEAT — a Zentropi signal failing while Coop is UP is NOT UNKNOWN here: Coop marks the
// leaf ERRORED, the rule doesn't fire, and Coop returns 200 []. Keeping child truly fail-closed in
// that case needs a user-authored IS_UNAVAILABLE companion child rule in Coop. See docs/v6-async-plane.md.)

import { randomUUID } from "node:crypto";
import type { GuardHit } from "$lib/chat/server/guardScreenTypes";
import { deployedEnv } from "../../../../config/inference";
import { logger } from "$lib/chat/server/logger";

// ── Coop env getters ────────────────────────────────────────────────────────────────────
function coopUrl(): string | undefined {
	return process.env.COOP_URL?.replace(/\/+$/, "") || undefined;
}
function coopApiKey(): string | undefined {
	return process.env.COOP_API_KEY || undefined;
}
function itemType(): string {
	return process.env.COOP_ITEM_TYPE || "ChatMessage";
}
// The default User item type id. Required for MRT author enqueue (the RELATED_ITEM author
// reference + the /items user submission both need this typeId). Unset → author wiring off.
function userTypeId(): string | undefined {
	return process.env.COOP_USER_TYPE_ID || undefined;
}
// The ChatMessage item type's UUID id. /report needs the id (it looks up reportedItem.typeId by id),
// whereas /content uses the COOP_ITEM_TYPE *name* — different resolution, so reporting carries its own
// env. Unset → reportToCoop skips (local saveReport still records the flag).
function itemTypeId(): string | undefined {
	return process.env.COOP_ITEM_TYPE_ID || undefined;
}
// COOP_SYSTEM_REPORTER_ID — the Coop User item id that a Shieldstral detection hit is reported AS (a
// system reporter, e.g. "shieldstral-gate", created once in Coop). Config, not a toggle: unset ⇒ the
// detection path cannot forward hits for review, a LOUD misconfiguration (one error per process, see
// reportHitToCoop), never a silent skip. (coop-review-plane Step 1b.)
function systemReporterId(): string | undefined {
	return process.env.COOP_SYSTEM_REPORTER_ID || undefined;
}
// Clamp BELOW Coop's hard 24s cap (with margin). If the app-side abort were >= 24s, a slow Coop
// returns 200 {actionsTriggered:[]} on its own cap — indistinguishable from clean — which would
// mis-map UNKNOWN to CLEAN for the fail-closed classes.
const MAX_TIMEOUT_MS = 20000;
function timeoutMs(): number {
	const n = Number(process.env.COOP_TIMEOUT_MS);
	const v = Number.isFinite(n) && n > 0 ? n : 8000;
	return Math.min(v, MAX_TIMEOUT_MS);
}
/** The longest one Coop screening call may take before the app aborts it. */
export const coopCallTimeoutMs = timeoutMs;
function parseList(raw: string | undefined, fallback: string): Set<string> {
	const src = (raw && raw.trim().length > 0 ? raw : fallback).split(",");
	return new Set(src.map((s) => s.trim()).filter(Boolean));
}
function childActions(): Set<string> {
	return parseList(process.env.COOP_CHILD_BLOCK_ACTIONS, "chat-block-child");
}
function contentBlockActions(): Set<string> {
	// Any configured block action that is NOT a child-safety action counts as content.
	const all = parseList(process.env.COOP_BLOCK_ACTIONS, "chat-block,chat-block-child");
	const child = childActions();
	return new Set([...all].filter((a) => !child.has(a)));
}
function redactActions(): Set<string> {
	// Empty by default: redact (non-blocking notice) is opt-in via COOP_REDACT_ACTIONS.
	// Redact stays EXACT-SET ONLY — it deliberately does NOT participate in the chat-block-* prefix
	// convention below, so a redact action must be named OUTSIDE that prefix (e.g. "chat-redact").
	return parseList(process.env.COOP_REDACT_ACTIONS, "");
}

// ── block-detection convention (auto-inherit) ──────────────────────────────────────────────────────
// A new blocking rule becomes identifiable with NO env edit + NO redeploy: give it its own action named
// by convention in the Coop dashboard — content → `chat-block-<x>`, child → `chat-block-child-<x>` — and
// these predicates auto-classify it as a block by PREFIX. The exact-set env lists above remain an
// authoritative override for non-conventional action names. Setting a prefix env var to the EMPTY string
// turns the convention OFF for that class (exact-set membership only = the pre-convention behavior).
//   COOP_BLOCK_ACTION_PREFIX        default "chat-block"        (content blocks)
//   COOP_CHILD_BLOCK_ACTION_PREFIX  default "chat-block-child"  (child blocks; checked FIRST)
// `??` (not `||`): an explicitly-empty value disables the convention; an UNSET var uses the default.
function contentPrefix(): string {
	return (process.env.COOP_BLOCK_ACTION_PREFIX ?? "chat-block").trim();
}
function childPrefix(): string {
	return (process.env.COOP_CHILD_BLOCK_ACTION_PREFIX ?? "chat-block-child").trim();
}
// A convention match is the prefix used as a NAMESPACE: the exact base action (`chat-block`) or the
// documented `<prefix>-<x>` form (`chat-block-violence`). It requires the `-` delimiter, so an unrelated
// action that merely shares the leading string (`chat-blocklist`, `chat-block-childish` vs the child
// prefix) is NOT swept in. Empty prefix → convention off.
function matchesPrefix(action: string, prefix: string): boolean {
	if (prefix.length === 0) return false;
	return action === prefix || action.startsWith(prefix + "-");
}
// Child precedence: a `chat-block-child-*` action is a child block, never a content block (the child
// prefix is a sub-namespace of the content prefix, so this MUST be checked first wherever both apply).
function isChildBlock(action: string): boolean {
	if (childActions().has(action)) return true;
	return matchesPrefix(action, childPrefix());
}
// Content block: in the content exact-set, OR matches the content prefix namespace — but NOT a child block.
function isContentBlock(action: string): boolean {
	if (isChildBlock(action)) return false;
	if (contentBlockActions().has(action)) return true;
	return matchesPrefix(action, contentPrefix());
}

// Off a deployment the seam is DISABLED (allow everything) unless Coop is configured, which is the
// local default. On a deployment, missing config is a misconfiguration and fails CLOSED instead: an
// env key that went missing must not switch the safety screen off (docs/guides/config-placement.md).
let warnedCoopOff = false;
export function isCoopConfigured(): boolean {
	const url = coopUrl();
	const key = coopApiKey();
	// Warn once whenever moderation is OFF — not only when config is PARTIAL.
	//
	// A strict XOR (`Boolean(url) !== Boolean(key)`) would fire only when exactly one of the two is
	// set. With NEITHER set — the local default, since COOP_URL and COOP_API_KEY are set in production
	// and preview but not local dev — content and child moderation are allow-all and the XOR says
	// nothing. An XOR is the wrong shape for "is this feature on": it reports
	// the operator's inconsistency rather than the system's state, and the all-quiet case is both the
	// most common and the one where the silence is most expensive.
	//
	// The two causes get different text because they need different fixes: a half-set pair is a typo
	// or a half-finished rollout, an empty pair is an environment that was never given the config.
	if (!warnedCoopOff && !(url && key)) {
		warnedCoopOff = true;
		if (coopRequired()) {
			logger.error(
				`[moderation] ${coopReviewConfigMissing()
					.filter((k) => k === "COOP_URL" || k === "COOP_API_KEY")
					.join(" and ")} unset on a deployment — every Coop verdict is UNKNOWN, so child safety fails CLOSED and turns screened by Coop are declined until the config is restored.`
			);
			return false;
		}
		logger.warn(
			url || key
				? "[moderation] Partial Coop config — set BOTH COOP_URL and COOP_API_KEY to enable; content/child moderation is DISABLED (allow-all) until then."
				: "[moderation] No Coop config (COOP_URL and COOP_API_KEY both unset) — content/child moderation is DISABLED (allow-all). Expected locally; in a deployed environment this means the safety screen is not running."
		);
	}
	return Boolean(url && key);
}

/** True on a deployment (DEPLOY_ENV/VERCEL_ENV is production or preview), where Coop config is required
 *  and its absence fails closed rather than disabling the screen. */
function coopRequired(): boolean {
	return isDeployment();
}

/** Coop config is missing where it is required. Callers treat this as an UNKNOWN verdict. */
function coopMissingOnDeployment(): boolean {
	return !isCoopConfigured() && coopRequired();
}

// Screen up to this many chars on the Coop submit. High enough to cover real chat turns so blocked
// content can't be buried past the cap (the model receives the full turn).
const MAX_TEXT = 100000;

// ── Coop verdict — ROUTE-LOCAL single fetch (NO module cache) ─────────────────────────────
// The gate fetches the verdict ONCE per turn and passes it to both owner-points. There is no
// cross-turn or concurrent-turn coalescing: every turn re-submits (fresh contentId, audit, strikes,
// current rule results). Standalone callers that omit `verdict` fetch their own.
export type CoopVerdict = { status: "ok" | "unknown"; actions: string[] };

// A strike-threshold ENQUEUE_AUTHOR_TO_MRT resolves the offending user via the ChatMessage's
// creatorId-roled `author` field AND requires that author USER item to have its own submission.
// Neither is created by /content. `/items/async/` returns 202 BEFORE its write lands and the inline
// insert is retried only once then swallowed, so a single 202 isn't durable — we (re)submit the user
// EVERY turn (fire-and-forget, idempotent on id+typeId). The enqueue only fires on the 3rd strike
// (≥3 separate turns), so earlier submissions have time to land; the strike-escalation webhook fires
// regardless, so the webhook is the guaranteed signal and MRT landing is best-effort. NEVER blocks
// the inline verdict.
// The raw user-item POST, awaited by BOTH callers below. May reject (network) or resolve non-ok —
// each caller owns its logging/detachment.
function postUserItem(userId: string, typeId: string): Promise<Response> {
	return fetch(`${coopUrl()}/api/v1/items/async/`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": coopApiKey() as string },
		body: JSON.stringify({ items: [{ id: userId, typeId, data: {} }] }),
		signal: AbortSignal.timeout(timeoutMs()),
	});
}

function submitUserItem(userId: string): void {
	const typeId = userTypeId();
	if (!typeId || !userId) return;
	postUserItem(userId, typeId)
		.then((res) => {
			if (!res.ok) logger.error({ status: res.status, userId }, `[moderation] user-item submit HTTP ${res.status}`);
		})
		.catch((err) => {
			logger.error({ err, userId }, "[moderation] user-item submit failed");
		});
}

// One /content POST — the flag-OFF Coop SYNC detector path. `includeAuthor` adds the creatorId-roled
// RELATED_ITEM `author` field (for the async MRT enqueue); contentId is fresh per call (Coop requires
// one). The abort is the env-derived, 20s-clamped timeoutMs() that guards the UNKNOWN↔CLEAN mapping.
// ONLY real turns land here — the warm ping never submits content (see pingCoopOrigin), so every
// /content call is a rule evaluation we mean. (Coop receives hit-only /report, not every turn.)
async function postContent(
	text: string,
	userId: string | undefined,
	includeAuthor: boolean,
	contentId: string = randomUUID()
): Promise<Response> {
	const authorTypeId = userTypeId();
	return fetch(`${coopUrl()}/api/v1/content`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": coopApiKey() as string },
		// sync:true for an inline verdict. userId enables async strike attribution. author is the
		// creatorId-roled RELATED_ITEM field → lets ENQUEUE_AUTHOR_TO_MRT find the author.
		body: JSON.stringify({
			contentType: itemType(),
			contentId,
			content: {
				text: text.slice(0, MAX_TEXT),
				...(includeAuthor && userId && authorTypeId
					? { author: { id: userId, typeId: authorTypeId } }
					: {}),
			},
			...(userId ? { userId } : {}),
			sync: true,
		}),
		signal: AbortSignal.timeout(timeoutMs()),
	});
}

// Submit one turn to Coop and return the triggered action names. Empty, or unconfigured off a
// deployment → clean (allow); unconfigured ON a deployment → unknown; reachable → ok;
// unreachable/5xx/timeout/bad-shape → unknown (callers fail by risk class).
export async function getCoopVerdict(text: string, userId?: string): Promise<CoopVerdict> {
	if (!text?.trim()) return { status: "ok", actions: [] }; // nothing to screen
	if (coopMissingOnDeployment()) {
		logger.error("[moderation] Coop unconfigured on a deployment — verdict UNKNOWN (child safety fails closed).");
		return { status: "unknown", actions: [] };
	}
	if (!isCoopConfigured()) return { status: "ok", actions: [] }; // local: seam disabled → allow
	const logFail = (msg: string, fields: Record<string, unknown> = {}) =>
		logger.error(fields, `[moderation] ${msg}`);
	const withAuthor = Boolean(userId && userTypeId());
	// (Re)submit the user as its own item so a strike-threshold MRT enqueue can resolve the author.
	// Fire-and-forget; never blocks or fails the verdict.
	if (withAuthor && userId) submitUserItem(userId);
	try {
		let res = await postContent(text, userId, withAuthor);
		// A 400 ONLY when we sent `author` means our async-bookkeeping field is malformed for Coop's
		// schema (e.g. a stale COOP_USER_TYPE_ID). That must NOT take down the inline verdict — else
		// it maps to UNKNOWN and fail-CLOSES child-safety on EVERY message. Retry once without author.
		if (res.status === 400 && withAuthor) {
			logFail("Coop 400 with author field — retrying without it (check COOP_USER_TYPE_ID)", { status: 400 });
			res = await postContent(text, userId, false);
		}
		if (!res.ok) {
			logFail(`Coop HTTP ${res.status} — UNKNOWN`, { status: res.status });
			return { status: "unknown", actions: [] };
		}
		const data = (await res.json()) as { actionsTriggered?: unknown };
		if (!Array.isArray(data?.actionsTriggered)) {
			// A 200 without a proper actionsTriggered array violates the contract — UNKNOWN, never
			// silently "clean".
			logFail("Coop 200 without actionsTriggered[] — UNKNOWN");
			return { status: "unknown", actions: [] };
		}
		const raw = data.actionsTriggered as Array<{ name?: unknown }>;
		const actions = raw.map((a) => a?.name).filter((n): n is string => typeof n === "string");
		if (actions.length !== raw.length) {
			// An action entry without a string `name` is a garbled response — we can't tell whether a
			// child/content block fired, so treat the whole verdict as UNKNOWN (fail by risk class)
			// rather than silently dropping a possibly-fired action.
			logFail("Coop actionsTriggered had an entry without a string name — UNKNOWN");
			return { status: "unknown", actions: [] };
		}
		return { status: "ok", actions };
	} catch (error) {
		logFail("Coop call failed/aborted — UNKNOWN", { err: error });
		return { status: "unknown", actions: [] };
	}
}

// ── child safety (Coop, fail CLOSED) ──────────────────────────────────────────────────────
// From the verdict: a child block action → flagged. UNKNOWN → flagged (fail CLOSED). A child-safety
// check that silently passes while Coop is unavailable is worse than no check — that asymmetry is why this is
// its own owner-point. Disabled (allow) only when Coop isn't configured (getCoopVerdict → ok/[]).
// `verdict` is the route-local pre-fetch; standalone callers omit it and one is fetched here.
// `category` is the SPECIFIC child action that fired (the rule identity), so the decline can resolve a
// curated label — it de-flattens the old `child_safety`-only collapse. Absent on a fail-closed UNKNOWN
// (no action fired) → the generic child-safety copy stands.
// `unscreened` marks a fail-closed UNKNOWN: flagged because the check could not run, not because it
// found anything. The decline copy and the badge say so (CUR-2301); kind and audit label are unchanged,
// so countFailClosedChildDeclines still counts it.
export type ChildSafetyResult = { flagged: boolean; category?: string; unscreened?: boolean };

export async function checkChildSafety(
	text: string,
	userId?: string,
	verdict?: CoopVerdict
): Promise<ChildSafetyResult> {
	const v = verdict ?? (await getCoopVerdict(text, userId));
	if (v.status === "unknown") {
		return { flagged: true, unscreened: true }; // fail CLOSED (no specific action → no category)
	}
	const child = v.actions.find(isChildBlock);
	return child ? { flagged: true, category: child } : { flagged: false };
}

// Firm, no "rephrase" invitation. Shown when a child-safety rule actually fired.
export const CHILD_SAFETY_DECLINE =
	"I can't help with that. This request was flagged by a child-safety classifier before it reached the model.";

// Shown on a fail-closed UNKNOWN: the safety screen did not finish, so nothing was flagged and the model
// never ran (CUR-2301). The copy must not name a classifier, which would tell people pasting a book
// chapter that they had been flagged for child safety.
const UNSCREENED_DECLINE =
	"We couldn't finish the safety check on this message, so it wasn't sent to the model. Nothing in it was flagged. Try a shorter message, or send it again in a moment.";

/** The input decline copy for a flagged child-safety result: the couldn't-check copy when the screen
 *  never returned a verdict, else the rule's own reviewed message, else the generic child-safety copy. */
export function childSafetyDeclineText(result: ChildSafetyResult, ruleMessage?: string | null): string {
	if (result.unscreened) return UNSCREENED_DECLINE;
	return ruleMessage ?? CHILD_SAFETY_DECLINE;
}

// ── content policy (Coop, fail OPEN: block / redact / allow) ──────────────────────────────
// From the SAME verdict: a content block action → "block" (hard decline); a redact action →
// "redact" (non-blocking notice chip); none → "allow". UNKNOWN → allow (fail OPEN — content is not
// load-bearing the way child-safety is). Coop action names carry NO user-facing text, so:
//   • block  → category = the action name (opaque code for the badge); NO message (gate uses the
//              reviewed CONTENT_POLICY_DECLINE). Never pass raw Coop/classifier text through.
//   • redact → category = the action name; message = a reviewed LOCAL default (CONTENT_NOTICE, or a
//              per-action override). Review-gated copy, rendered as escaped plain text in the chip.
export type ContentPolicyAction = "allow" | "block" | "redact";
export type ContentPolicyResult = {
	action: ContentPolicyAction;
	category?: string;
	message?: string;
};

// Reviewed local notice copy for a "redact" action (short, honest, non-moralizing). Coop supplies no
// copy, so this is ours. Per-action overrides keyed on the Coop action name (none by default).
const CONTENT_NOTICE = "An open content-safety policy flagged this turn for review.";
const CONTENT_NOTICE_BY_ACTION: Record<string, string> = {};
function contentNotice(action: string): string {
	return CONTENT_NOTICE_BY_ACTION[action] ?? CONTENT_NOTICE;
}

export async function checkContentPolicy(
	text: string,
	userId?: string,
	verdict?: CoopVerdict
): Promise<ContentPolicyResult> {
	const v = verdict ?? (await getCoopVerdict(text, userId));
	if (v.status === "unknown") {
		return { action: "allow" }; // fail OPEN
	}
	const blocked = v.actions.find(isContentBlock);
	if (blocked) {
		return { action: "block", category: blocked };
	}
	const redacted = v.actions.find((a) => redactActions().has(a));
	if (redacted) {
		return { action: "redact", category: redacted, message: contentNotice(redacted) };
	}
	return { action: "allow" };
}

// Default decline copy for a content "block" when Coop supplies no per-policy message. Names a
// content policy, not a language classifier. Review-gated.
export const CONTENT_POLICY_DECLINE =
	"I can't help with that. This request was flagged by an open content-safety policy before it reached the model.";

// ── non-blocking advisory tier (inert) ────────────────────────────────────────────────────
// The third safety shape: the model still runs and answers, and a `safetyNotice` chip rides
// alongside. The content "redact" path already feeds that chip, so this generic tier stays inert
// (fail-OPEN by construction: returns `{ notice: false }`).
export type AdvisoryResult = { notice: boolean; category?: string; message?: string };


export async function checkAdvisory(_text: string): Promise<AdvisoryResult> {
	return { notice: false };
}

// ── Warmup (TTFT) ────────────────────────────────────────────────────────────────────────────────
// The input gate's latency tail is a COLD BACKEND, not the classify itself: Coop's scale-to-zero
// ORIGIN cold-boots (Cloudflare cf-cache is DYNAMIC, so every call hits the
// origin, and the boot runs longer than 20s). Pinging it BEFORE the user sends wakes the backend +
// primes the undici keep-alive pool, so the real turn's gate is warm. Best-effort: never throws,
// never blocks a turn. Per-instance throttle (serverless: each instance warms itself — which is
// exactly the cold one).
//
// The Coop leg is a RULE-FREE GET, NOT a /content submit. The old warm posted a fixed string to
// /api/v1/content, which ran the full rule set — a Zentropi/CoPE detector evaluation every warm
// cycle (every ~2 min via the cron, around the clock) for a verdict that was discarded. Waking the
// origin only needs A request to reach it; any cheap route does that with zero rule evaluations.
//
// Per-instance throttle >= the Coop warm abort below, so a long compose session can't kick off a second
// warm on the same instance while the first (up to 60s against a deep-cold origin) is still in flight.
const WARM_THROTTLE_MS = 60_000;
// Generous warm-ping timeout (vs the per-turn 8s): the warm ping's whole job is to ABSORB a cold
// backend's wake. Coop's origin cold-boot runs longer than the 20s per-turn abort, which would end
// the ping before the wake finished, so it gets 60s; the every-2-min /api/warm cron then keeps it warm. Runs in the background (client
// pingWarm / cron waitUntil), never on a user's hot path.
const WARM_COOP_TIMEOUT_MS = 60_000;
let lastWarmAt = 0;

// Rule-free warm path on the Coop origin. Default /health (answers 200; /graphql
// is a 404). Override with COOP_WARM_PATH. The status of the response is IGNORED — even a
// 404/405 had to boot the origin to be produced — so a wrong path still warms; it just can't
// exercise deeper layers (DB) the way a health route can.
function coopWarmPath(): string {
	const raw = (process.env.COOP_WARM_PATH || "/health").trim();
	return raw.startsWith("/") ? raw : `/${raw}`;
}

// Wake Coop's origin WITHOUT running any rules (zero Zentropi/detector calls). Success = any HTTP
// response. The body is drained so undici returns the socket to the keep-alive pool — priming that
// pool is the second half of what this warms. Never throws; failure logs at `info` (a cold-instance
// warm ping racing a deep-cold origin is benign and must not read as a Coop failure in alerting —
// real per-turn calls still log failures at `error`).
async function pingCoopOrigin(): Promise<void> {
	if (!isCoopConfigured()) return;
	try {
		const res = await fetch(`${coopUrl()}${coopWarmPath()}`, {
			method: "GET",
			headers: { "x-api-key": coopApiKey() as string },
			signal: AbortSignal.timeout(WARM_COOP_TIMEOUT_MS),
		});
		await res.arrayBuffer();
	} catch (error) {
		logger.info({ err: error }, "[moderation] warm Coop ping failed (benign cold-start)");
	}
}

export async function warmModeration(): Promise<void> {
	const now = Date.now();
	if (now - lastWarmAt < WARM_THROTTLE_MS) return; // already warm on this instance
	lastWarmAt = now;
	// Rule-free origin GET (never a /content submit); swallows everything itself (a warm failure
	// must never surface to a user).
	await pingCoopOrigin();
}

// Synthetic Coop VERDICT-path health probe — the honest "can Coop return a verdict right now" signal,
// unlike warmModeration's swallowed origin ping which is ALWAYS ok (see CUR-35). Runs the REAL verdict
// path (getCoopVerdict → POST /api/v1/content, sync) with fixed BENIGN content and NO userId ⇒ no author
// attribution, no strikes, no data pollution. Healthy iff Coop returns a well-formed, non-UNKNOWN verdict
// — UNKNOWN (unreachable / 5xx / timeout / bad-shape) is the EXACT state that fail-CLOSES real turns into
// CHILD_SAFETY_DECLINE. Two attempts absorb a cold-socket race (getCoopVerdict's own timeout spaces them);
// SUSTAINED failure across probes is what alerts (alerting.ts recordProbe). Deliberately reintroduces a
// per-probe rule evaluation that warming dropped for cost — so the caller THROTTLES it (see warm.ts), a
// few evals/hour vs the per-turn evals real traffic already spends. Returns null when Coop isn't configured.
const COOP_HEALTH_PROBE_TEXT = "health probe: the quick brown fox jumps over the lazy dog";
export async function probeCoopHealth(): Promise<boolean | null> {
	// On a deployment, missing config is a failure the alert must see, not "nothing to watch".
	if (coopMissingOnDeployment()) return false;
	if (!isCoopConfigured()) return null;
	for (let attempt = 0; attempt < 2; attempt++) {
		const v = await getCoopVerdict(COOP_HEALTH_PROBE_TEXT).catch(
			(): CoopVerdict => ({ status: "unknown", actions: [] })
		);
		if (v.status === "ok") return true;
	}
	return false;
}

// ── OUTPUT moderation (screen the model's ANSWER, not just the input) ───────────────────────────
// Defense-in-depth: input screening can't catch a harmful GENERATION (a benign prompt that yields a
// harmful answer, or a jailbreak). This screens the model's COMPLETE output with the SAME Coop content
// + child policies (injection is an input-only attack → not re-run). It reuses checkChildSafety
// (fail CLOSED on UNKNOWN) and checkContentPolicy (fail OPEN), so the output inherits the same
// per-policy fail modes as the input gate — one Coop /content call on the output, both owner-points
// reuse it.
//
// Opt-in: requires Coop configured AND OUTPUT_MODERATION on. You CANNOT screen an answer and stream it
// live at the same time (the user would see unscreened tokens), so the caller SUPPRESSES live token
// streaming and holds the whole answer until this clears — a real UX change (no token-by-token), which
// is why it's behind a flag and OFF by default. See the chat handler's generation loop and
// docs/v6-runbook.md "Output gating".
// The ENV parse only — is OUTPUT_MODERATION requested? (coop-review-plane Step 3a). Split out from
// outputModerationEnabled so resolveTurnPolicy can branch by source: under guard-primary the guard is the
// detector, so requested-ON is enough (its OWN loud-UNKNOWN handles a missing endpoint — never a silent
// off); the flag-OFF Coop branch still ANDs isCoopConfigured() below.
export function outputModerationRequested(): boolean {
	const raw = (process.env.OUTPUT_MODERATION ?? "").trim().toLowerCase();
	return raw === "true" || raw === "1" || raw === "on";
}
export function outputModerationEnabled(): boolean {
	// On a deployment, requested is enough: screenModelOutput then fails closed on the missing config.
	return outputModerationRequested() && (isCoopConfigured() || coopRequired());
}

export type OutputScreenResult = {
	blocked: boolean;
	kind: "child_safety" | "content_policy" | null;
	/** Coop action name behind the block (the rule identity, content OR child); undefined for none or a
	 *  fail-closed UNKNOWN. SERVER-SIDE ONLY — resolved to a curated label before it reaches the client. */
	category?: string;
	/** A child_safety block from a fail-closed UNKNOWN: the screen never returned a verdict, so nothing
	 *  was flagged (CUR-3891). The decline then says the check couldn't finish, never that a classifier
	 *  flagged the answer. */
	unscreened?: boolean;
	/** Every fired guard rule (block ∪ log) — for the output review report (coop-review-plane Step 3c),
	 *  server-only. The Coop-shaped screenModelOutput leaves it undefined; screenOutputWithGuard sets it. */
	hits?: GuardHit[];
	/** A content block on a screen whose child query went unanswered, so the re-check never lifts it
	 *  (CUR-3975). Server-only. */
	childUnknown?: boolean;
};

// Screen one complete model answer. Disabled/empty/clean → not blocked. child block (or fail-closed
// UNKNOWN) → blocked child; content block → blocked content. `verdict` lets a caller pass a pre-fetched
// CoopVerdict; otherwise one is fetched here.
export async function screenModelOutput(
	text: string,
	userId?: string,
	verdict?: CoopVerdict
): Promise<OutputScreenResult> {
	if (!text?.trim() || (!isCoopConfigured() && !coopRequired())) return { blocked: false, kind: null };
	const v = verdict ?? (await getCoopVerdict(text, userId));
	const child = await checkChildSafety(text, userId, v); // fail CLOSED on UNKNOWN
	if (child.flagged) return { blocked: true, kind: "child_safety", category: child.category };
	const content = await checkContentPolicy(text, userId, v); // fail OPEN on UNKNOWN
	if (content.action === "block") {
		return { blocked: true, kind: "content_policy", category: content.category };
	}
	return { blocked: false, kind: null };
}

// Shown when the model's OWN answer is withheld by output screening — distinct from the input declines
// (here the model produced something and we held it before showing it, hence "I started to answer").
// Review-gated copy, same honest, non-moralizing register as the input declines.
export const OUTPUT_CONTENT_DECLINE =
	"I started to answer, but my response was flagged by an open content-safety policy before it was shown, so I've held it back.";
export const OUTPUT_CHILD_SAFETY_DECLINE =
	"I started to answer, but my response was flagged by a child-safety classifier before it was shown, so I've held it back.";

// Shown when output screening releases a clean PREFIX of the answer and then a later sentence is
// flagged — we keep what already cleared and stop, appending this notice (we never yank shown-clean
// text; once bytes reach the client they're captured, so retraction isn't a control). Review-gated.
export const OUTPUT_CONTENT_TRUNCATE =
	"_[The rest of this response was withheld by an open content-safety policy.]_";
export const OUTPUT_CHILD_SAFETY_TRUNCATE =
	"_[The rest of this response was withheld by a child-safety classifier.]_";

// Shown when the output screen could not finish (fail-closed UNKNOWN): the answer is held back
// unchecked and nothing in it was flagged (CUR-3891), the output twin of UNSCREENED_DECLINE.
// Review-gated copy.
export const OUTPUT_UNSCREENED_DECLINE =
	"I wrote an answer but couldn't finish its safety check, so I've held it back. Nothing in it was flagged. Try sending your message again in a moment.";
export const OUTPUT_UNSCREENED_TRUNCATE =
	"_[The rest of this response was held back because its safety check couldn't finish. Nothing in it was flagged.]_";

// ── user reports (Coop /api/v1/report) ──────────────────────────────────────────────────────────
// A user flags a response with the ReportButton → we forward it to Coop so it surfaces in the triage
// dashboard. FIRE-AND-FORGET: the local saveReport already persisted the flag, so a Coop failure (or
// missing config) must never fail the user's report. Skips silently unless the FULL contract is
// present — Coop configured, a typed reporter (COOP_USER_TYPE_ID), a typed item (COOP_ITEM_TYPE_ID),
// a reporter id, a message id, and message text. A guest reporter is keyed by sessionId, matching how
// the content path already treats guests as users-keyed-by-session.
//
// typeId NOTE: reportedItem.typeId is the item type's UUID *id* (COOP_ITEM_TYPE_ID), NOT the
// COOP_ITEM_TYPE name /content submits under — /report resolves the type by id, /content by name.
// The shared POST /api/v1/report body builder + fetch, used by BOTH the user-report route and the
// detection path (coop-review-plane Step 1b). Validates only the COMMON config: Coop configured, a typed
// reporter type (COOP_USER_TYPE_ID), a typed item type (COOP_ITEM_TYPE_ID, resolved by id — /report looks
// up reportedItem.typeId by id, not by the COOP_ITEM_TYPE name /content uses), a reporter id, and a
// reported item id. Caller-specific validation (non-empty text for user reports; non-empty hits for
// detections) lives in the public wrappers. Returns a CAUGHT Promise<void> — it NEVER rejects, so a
// caller can hand it to runInBackground and the turn is never affected. Single attempt, no retry
// (best-effort — same as before). 201 is success; anything else logs loudly (fire-and-forget gives no
// other signal).
function postReport(input: {
	reporterId: string;
	reason: string;
	reportedItemId: string;
	data: Record<string, unknown>;
	/** The `coop_report_rate_limited` e2e fault: Coop's answer is this status, and no request is sent. */
	injectedStatus?: number;
}): Promise<void> {
	const url = coopUrl();
	const key = coopApiKey();
	const reporterTypeId = userTypeId();
	const reportedTypeId = itemTypeId();
	if (!url || !key || !reporterTypeId || !reportedTypeId || !input.reporterId || !input.reportedItemId) {
		return Promise.resolve();
	}
	const started = Date.now();
	const send = input.injectedStatus
		? Promise.resolve(new Response("injected by the coop_report_rate_limited fault", { status: input.injectedStatus }))
		: fetch(`${url}/api/v1/report`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": key },
		body: JSON.stringify({
			reporter: { kind: "user", typeId: reporterTypeId, id: input.reporterId },
			reportedAt: new Date().toISOString(),
			reportedForReason: { reason: input.reason },
			reportedItem: { id: input.reportedItemId, typeId: reportedTypeId, data: input.data },
		}),
		signal: AbortSignal.timeout(timeoutMs()),
			});
	return send
		.then(async (res) => {
			if (res.status !== 201) {
				// Coop's body names the field it refused; without it a 400 can't be diagnosed from the logs.
				const detail = await res.text().catch(() => "");
				logger.error(
					{ status: res.status, reason: input.reason, itemId: input.reportedItemId },
					`[moderation] Coop report HTTP ${res.status} (${input.reason}) for item ${input.reportedItemId}: ${detail.slice(0, 500)}`
				);
				return;
			}
			// The success line too, so a report can be confirmed from the logs rather than inferred from
			// the absence of an error (CUR-2382).
			logger.info(
				{ status: 201, reason: input.reason, itemId: input.reportedItemId, ms: Date.now() - started },
				`[moderation] Coop report 201 (${input.reason}) for item ${input.reportedItemId} in ${Date.now() - started} ms`
			);
		})
		.catch((err) => logger.error({ err, reason: input.reason, itemId: input.reportedItemId }, "[moderation] Coop report failed"));
}

// A user flags a response with the ReportButton → forward it to Coop's triage dashboard. Returns the
// caught fetch chain, so runInBackground can keep it alive on Vercel. FIRE-AND-FORGET: the local
// saveReport already persisted the flag, so a Coop failure or missing config must never fail the user's report. Skips (resolved promise) unless the
// full user-report contract is present — the typed reporter/item come from postReport; here we require a
// reporter id, a message id, and non-empty message text. A guest reporter is keyed by sessionId, matching
// how the content path treats guests.
export function reportToCoop(input: {
	messageId: string | undefined;
	text: string | undefined;
	reason: string;
	reporterId: string | undefined;
	injectedStatus?: number;
}): Promise<void> {
	if (!input.reporterId || !input.messageId || !input.text?.trim()) return Promise.resolve();
	return postReport({
		reporterId: input.reporterId,
		reason: input.reason,
		reportedItemId: input.messageId,
		data: { text: input.text.slice(0, MAX_TEXT) },
		injectedStatus: input.injectedStatus,
	});
}

// ── detection hits → Coop REVIEW plane (coop-review-plane Step 1b) ────────────────────────────────
// The chat gate forwards ONLY turns that fired a detection rule (block or log) to Coop's triage queue,
// reported AS a fixed system reporter. Coop is the REVIEW plane here — /report does NOT re-run Coop's own
// rules (that would be Coop-as-detector, the thing this plan removes). The reason is the fired rule key
// (a block key wins over a log key); the data carries EVERY fired rule + surface + subject + scope so a
// reviewer sees the whole detection and the action taken.
//
// SCOPE: file/image/history bytes NEVER go to Coop (swap plan r3 #3). `text` is the typed turn text on
// chat-input and the assistant's own answer on chat-output. It MAY be EMPTY on chat-input — an
// image/file-only hit reports with empty text + the hits, and the reviewer follows `messageId` into the
// admin tooling for the bytes; the system path deliberately does NOT require non-empty text (a real hit
// with no typed text must still land). Fire-and-forget, single attempt, NEVER rejects — the caller hands
// it to runInBackground.
/** The review-plane keys that are unset. Detection hits and CSAM hash matches reach Coop's review
 *  queue only when this is empty; warm.ts alerts on a deployment where it is not. */
export function coopReviewConfigMissing(): string[] {
	return [
		["COOP_URL", coopUrl()],
		["COOP_API_KEY", coopApiKey()],
		["COOP_USER_TYPE_ID", userTypeId()],
		["COOP_ITEM_TYPE_ID", itemTypeId()],
		["COOP_SYSTEM_REPORTER_ID", systemReporterId()],
	]
		.filter(([, value]) => !value)
		.map(([key]) => key as string);
}

/** True on a deployment (DEPLOY_ENV/VERCEL_ENV is production or preview). */
export function isDeployment(): boolean {
	return deployedEnv(process.env) !== null;
}

let warnedReportConfig = false;
export function reportHitToCoop(input: {
	/** "storage-upload" is a picture saved to My files; messageId is then its quarantine path. (CUR-3201) */
	surface: "chat-input" | "chat-output" | "storage-upload";
	messageId: string;
	text: string;
	hits: GuardHit[];
	subjectId: string | undefined;
}): Promise<void> {
	if (input.hits.length === 0) return Promise.resolve();
	const reporterId = systemReporterId();
	const missing = coopReviewConfigMissing();
	if (missing.length > 0) {
		// The detector can operate without Coop. Every missing review credential must therefore
		// be visible here, even when no legacy Coop detector call runs to warn about it.
		if (!warnedReportConfig) {
			warnedReportConfig = true;
			logger.error(
				`[moderation] ${missing.join(", ")} unset — Shieldstral detection hits are NOT forwarded to Coop for review.`
			);
		}
		return Promise.resolve();
	}
	// A block key names the reason (it is why the turn was refused); else the first log key.
	const reasonKey = (input.hits.find((h) => h.action === "block") ?? input.hits[0])!.key;
	const scope =
		input.surface === "chat-input" ? "typed-text-only" : input.surface === "chat-output" ? "assistant-output" : "stored-file";
	return postReport({
		reporterId: reporterId!,
		reason: `shieldstral:${reasonKey}`,
		reportedItemId: input.messageId,
		data: {
			text: input.text.slice(0, MAX_TEXT),
			detection: {
				source: "shieldstral",
				surface: input.surface,
				hits: input.hits,
				subjectId: input.subjectId,
				scope,
			},
		},
	});
}

// A known-CSAM hash match (Meta HMA/PDQ) at upload, reported the same way a Shieldstral
// detection hit is — a system reporter, no bytes, into Coop's triage queue — so the one named review
// team works one queue for every severe verdict rather than a hash match living only in an alert channel
// (alerting.ts's recordCsamMatch, which pages ops in real time but isn't a queue anyone works through).
// Same missing-config posture as reportHitToCoop: operates without Coop, loud-once when it can't report.
//
// `reportedItemId` is NOT always a ChatMessage id, unlike reportHitToCoop's: the chat-message upload
// guard refuses the request before any message is persisted, so it has only the conversation id to
// give — the caller passes whatever real, already-existing id it has (conversation or message). (CUR-986)
let warnedCsamReportConfig = false;
export function reportCsamMatchToCoop(input: {
	reportedItemId: string;
	bankName: string;
	bankContentId: number;
	distance: string;
}): Promise<void> {
	const reporterId = systemReporterId();
	const missing = coopReviewConfigMissing();
	if (missing.length > 0) {
		if (!warnedCsamReportConfig) {
			warnedCsamReportConfig = true;
			logger.error(`[moderation] ${missing.join(", ")} unset — CSAM hash matches are NOT forwarded to Coop for review.`);
		}
		return Promise.resolve();
	}
	return postReport({
		reporterId: reporterId!,
		reason: `csam-hash-match:${input.bankName}`,
		reportedItemId: input.reportedItemId,
		data: {
			// Coop's ChatMessage item type requires `text` (coop-deploy/cooplocal/bootstrap.mjs), and a
			// report without it is refused with HTTP 400 (CUR-2382). There is no
			// message text to send and the image bytes must never leave us, so the text describes the
			// verdict instead.
			text: `Known-CSAM hash match on upload: bank ${input.bankName}, content id ${input.bankContentId}, PDQ distance ${input.distance}. No file content is forwarded.`,
			detection: {
				source: "hma-pdq",
				bankName: input.bankName,
				bankContentId: input.bankContentId,
				distance: input.distance,
			},
		},
	});
}

/** TESTS ONLY — reset the once-per-process report warning latch so the loud-skip contract is testable. */
export function __resetReportWarningsForTest(): void {
	warnedReportConfig = false;
	warnedCsamReportConfig = false;
}
