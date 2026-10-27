import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { config } from "$lib/chat/server/config";
import { firstKey } from "$lib/chat/server/env/firstKey";
import { warmModeration, probeCoopHealth, coopReviewConfigMissing, isDeployment } from "$lib/chat/server/moderation";
import {
	probeGuardHealth,
	guardPrimaryEnabled,
	guardPrimaryConfigured,
} from "$lib/chat/server/guardGate";
import { safetyScreenConfigured } from "$lib/chat/server/safetyScreen";
import { takeErrorCount, captureServerException } from "$lib/chat/server/errorTracking";
import { takeAgentRouteFailureCount } from "$lib/chat/server/chat/resolveAgentRoute";
import { recordProbe } from "$lib/chat/server/alerting";
import { countFailClosedChildDeclines } from "$lib/chat/server/db/safetyEvents";
import {
	countTurnOutcomes,
	pruneTurnOutcomes,
	recentCompleteTtfts,
	turnOutcomeRecovery,
} from "$lib/chat/server/db/turnOutcomes";
import { FAILURE_OUTCOMES } from "$lib/chat/utils/outcomeLadder";
import { TURN_OUTCOME_WINDOW_MS, turnOutcomeVerdict } from "$lib/chat/server/turnOutcomeVerdict";
import { TURN_SPEED_SAMPLE, TURN_SPEED_WINDOW_MS, turnSpeedVerdict } from "$lib/chat/server/turnSpeedVerdict";
import { refreshRegistryGatesIfChanged } from "$lib/chat/server/models";
import { probeDueModels, type ProbeTarget } from "$lib/chat/server/modelProbe";
import { refreshFlags } from "$lib/chat/server/flags";
import { resolveProviderModelId } from "$lib/chat/server/endpoints/openai/providerPin";
import { primaryModelId } from "$lib/chat/server/primaryModel";
import { directWire, mistralChatEndpoint } from "$lib/chat/server/modelsCatalog";
import { rolesNeedFlattening } from "$lib/chat/server/modelProfiles";
import { mistralChatLane } from "$lib/chat/server/mistralKey";
import { probeMistralModelList } from "$lib/chat/server/mistralVersions";
import { embedText, cosine } from "$lib/chat/server/rag/embed";
import ragIndex from "$lib/chat/server/rag/data/rag-index.json";
import { sameServedModel } from "../../../../config/picker";
import { syftEnabled, syftRouter } from "$lib/chat/server/rag/env";
import { getDb } from "$lib/chat/server/db/client";
import { logger } from "$lib/chat/server/logger";

/**
 * Every leg below throttles on real `Date.now()`, and the per-leg windows are short — 15s for db,
 * 30s for most. That makes a test asserting "two calls, one probe" depend on both calls landing
 * inside that window in WALL-CLOCK time, so warm.spec.ts goes red under host load with nothing wrong
 * in the diff. A gate whose verdict depends on what else is running on the machine is not a gate.
 *
 * WARM_THROTTLE_MS is a test seam: when set, it REPLACES every leg's window, so the spec can pick
 * one large enough that elapsed real time cannot reach it. It is config, not a feature flag —
 * nothing is gated on it and it only widens a debounce. Unset in every deployed config, which is
 * why the per-leg constants below stay the documented production values rather than moving to env.
 *
 * A non-numeric or non-positive value falls back to the per-leg default rather than throttling
 * forever or never — a typo'd override must not silently disable a health probe.
 *
 * Read per call, not captured at module load: the spec mocks `config` with a mutable object and
 * varies it per test, and a module-level read would freeze the first test's value for the file.
 */
const throttleMs = (perLegDefault: number): number => {
	const override = Number(config.WARM_THROTTLE_MS);
	return Number.isFinite(override) && override > 0 ? override : perLegDefault;
};

/** Run one warm leg's WORK with structured per-leg observability: time it, emit a single outcome line
 *  ([warm] leg=<name> ok=<bool> ms=<n>), and SWALLOW any error so the leg stays individually best-effort
 *  (each warm* fn must never throw — see warm.spec.ts) while its outcome stays visible, so a leg that
 *  fails every cron cycle cannot do so silently.
 *
 *  `ok` is WHATEVER `work` RETURNS, not "did it throw" (CUR-114). Absence-of-throw as the default
 *  verdict makes completion-as-verdict the ergonomic path, so every new leg would start in the wrong
 *  shape. `embedText` and `getSyftCatalog` both fail open internally (return `null`, never throw), so
 *  their legs would report `ok=true` on every endpoint failure unless their call sites return the real
 *  verdict instead of the resolved value. A leg with no real verdict to give (moderation/space, which
 *  swallow internally) must say so explicitly, `return true` after awaiting, rather than getting it
 *  for free.
 *
 *  Called only on a leg's WORK path (after the throttle/config guards), so a throttle-skip logs
 *  nothing. RETURNS the outcome so a leg whose `ok` is HONEST can feed alerting.recordProbe; a leg that
 *  swallows internally must not (its `ok` is structurally true — see the moderation note above and
 *  CUR-35).
 *
 *  `extra` is evaluated AFTER the work (so it can report what the work observed) and merged into both
 *  the success and failure line. It exists because these lines are the cheapest continuous health
 *  record we have, and a leg that can run against more than one lane must say WHICH one on every
 *  line — otherwise the record is a year of `leg=model ok=true` that cannot answer "serving what?". */
async function timedWarm(
	leg: string,
	work: () => Promise<boolean>,
	extra?: () => Record<string, unknown>
): Promise<boolean> {
	const start = Date.now();
	const fields = () => {
		try {
			return extra?.() ?? {};
		} catch {
			return {}; // observability must never be the thing that fails a leg
		}
	};
	try {
		const ok = await work();
		const logFields = { leg, ok, ms: Date.now() - start, ...fields() };
		if (ok) logger.info(logFields, "[warm] leg");
		else logger.warn(logFields, "[warm] leg");
		return ok;
	} catch (e) {
		logger.warn(
			{
				leg,
				ok: false,
				ms: Date.now() - start,
				err: e instanceof Error ? e.message : String(e),
				...fields(),
			},
			"[warm] leg"
		);
		return false;
	}
}

// ── Shared-backend warmup (TTFT) ─────────────────────────────────────────────────────────────────
// The served model is ONE endpoint shared by every user, so a single warm call per instance keeps it
// hot for everyone — and firing it when a user ARRIVES (not when they send) hides the cold-start
// behind their read/type time. We warm the SAME lane the real turn will use — resolveWarmLane below is
// where that correspondence is kept. Warming a different backend would leave the real lane cold AND
// assert identity about a lane nobody is on.
// Best-effort + per-instance throttled: a warm failure never surfaces, and repeat pings are cheap.
// Cost is ~1 generated token per throttle window.

const MODEL_WARM_THROTTLE_MS = 30_000;
let lastModelWarmAt = 0;

/** The lane a REAL default turn would use right now. `wireId` is the id sent on the wire, which is
 *  also the id the response must echo back for the identity assertion to pass. */
type WarmLane = { name: "primary" | "mistral"; baseURL: string; key: string; wireId: string };

/**
 * Resolve the lane to warm and assert against, the same way the turn path resolves it.
 *
 * This resolves one lane, the same one a default turn resolves to (CUR-243). It exists rather than
 * being inlined because a turn that resolves to a second registration while this leg probes the
 * configured primary leaves `model:identity` green about a lane no user is on, and the lane every user
 * is on unchecked: a check that can go red, but not for the failure it names (CUR-113).
 *
 * The registrations are collapsed now, so the primary IS what a default turn gets. Keep it that way:
 * anything that makes a turn resolve to a model other than `primaryModelId()` has to be reflected
 * here in the same change, or this probe silently goes back to asserting the wrong thing.
 *
 * A Mistral primary is a second registration of exactly that kind: its turns go to `mistralChatLane()`'s
 * host under the host's own name for the model (`models.ts`, `mistralEndpoint`), never to
 * OPENAI_BASE_URL. So it is warmed there, under that name (CUR-3848).
 */
async function resolveWarmLane(): Promise<WarmLane | null> {
	const model = primaryModelId();
	if (!model) return null;
	const mistral = mistralPrimaryLane(model);
	if (mistral) return mistral;
	const baseURL = config.OPENAI_BASE_URL?.replace(/\/+$/, "");
	const key = firstKey(["OPENAI_API_KEY", "HF_TOKEN"], "warmModelToken");
	if (!baseURL || !key) return null;
	return {
		name: "primary",
		baseURL,
		key,
		wireId: resolveProviderModelId(model, undefined, config.OPENAI_PROVIDER),
	};
}

/** The Mistral lane when it serves `model`, as a real turn would reach it; null when it doesn't. */
function mistralPrimaryLane(model: string): WarmLane | null {
	const direct = mistralChatEndpoint();
	if (!direct?.modelIds.includes(model)) return null;
	return {
		name: "mistral",
		baseURL: direct.baseURL,
		key: mistralChatLane().apiKey,
		wireId: directWire(direct, model).modelId ?? model,
	};
}

/**
 * The primary model when it is served straight from La Plateforme (CUR-2272), else undefined.
 *
 * @remarks
 * That lane has no cold start to hide and no gateway that could substitute another model, so probing
 * it would spend Mistral's rate limit on every page load for a log line (CUR-2284). The staging router is a
 * LiteLLM gateway that caches and could answer with another model, and
 * production's primary is Large 3 through it, so it is probed like the gateway (CUR-3848). The
 * router lane is the one keyed by MISTRAL_CHAT_API_KEY; `mistralChatLane()` falls back to La
 * Plateforme on any other key.
 */
function directPrimary(): string | undefined {
	const primary = primaryModelId();
	if (!primary || mistralChatLane().keyEnv === "MISTRAL_CHAT_API_KEY") return undefined;
	return mistralPrimaryLane(primary) ? primary : undefined;
}

/** Wake the served model endpoint with a 1-token completion on the lane a real turn would use. */
export async function warmModel(): Promise<void> {
	const now = Date.now();
	if (now - lastModelWarmAt < throttleMs(MODEL_WARM_THROTTLE_MS)) return; // already warm on this instance
	const direct = directPrimary();
	if (direct) {
		lastModelWarmAt = now;
		logger.info({ leg: "model", model: direct, skipped: "direct-lane" }, "[warm] leg skipped");
		return;
	}
	const lane = await resolveWarmLane();
	if (!lane) return; // not enough config to warm → skip silently
	const { baseURL, key } = lane;
	lastModelWarmAt = now;
	const id = lane.wireId;
	// timedWarm times + logs [warm] leg=model ok=… and swallows, so a cold/WAF-blocked endpoint surfaces
	// as ok=false instead of vanishing — while warmModel itself stays best-effort (never throws).
	// The non-2xx THROW below is load-bearing: fetch RESOLVES on 4xx/5xx, so without it a WAF 403, a
	// provider 503, or a rotated-out model id would all log ok=true, and the only model failure mode
	// visible would be a network timeout. This is the same always-green trap as the moderation leg
	// (CUR-35), one layer down.
	// Captured inside the leg, asserted after it: reachability and identity are DIFFERENT failures with
	// different runbooks, so a served-model swap must not present as a failure (and vice versa).
	// A holder object, not a bare `let`: TS's control-flow analysis does not track assignment inside the
	// callback below, so a plain `let served` reads as `never` at every use site after it.
	type Served = { model?: string; provider?: string; backend?: string; cached?: boolean };
	const cap: { served: Served | null; busy: boolean } = { served: null, busy: false };
	const ok = await timedWarm(
		"model",
		async () => {
			const res = await fetch(`${baseURL}/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${key}`,
					// The HF router WAF 403s the OpenAI SDK's default UA; mirror the endpoint's override.
					"User-Agent": "aipotluck.org",
				},
				body: JSON.stringify({
					model: id,
					// A different prompt every call, so no response cache can answer it. The gateway's
					// LiteLLM cache answers a fixed "hi" itself (`x-litellm-cache-key` present, under a
					// millisecond of gateway time, against hundreds of ms from a real host), so such a leg
					// reads ok while real turns time out, without reaching, measuring or warming a model
					// (CUR-2242).
					// The shape the answer lane sends this model (CUR-1294): a host that refuses a system role
					// can answer a bare user "hi" itself while every real turn falls back to another model, so
					// a one-message probe stays green through exactly the swap model:identity exists to catch.
					messages: rolesNeedFlattening(id)
						? [{ role: "user", content: `hi ${randomUUID()}` }]
						: [
								{ role: "system", content: "You are a helpful assistant." },
								{ role: "user", content: `hi ${randomUUID()}` },
							],
					max_tokens: 1,
					stream: false,
				}),
				signal: AbortSignal.timeout(20_000),
			});
			// A 429 is the host answering that its per-minute limit is full, which real turns hit too in a
			// busy minute. It says the lane is up and says nothing about the model, so it is no verdict
			// (CUR-3848): logged as busy, kept out of model:warm's failure count below.
			cap.busy = res.status === 429;
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			// Read WHICH model answered, not just that something did. Same provenance the turn path uses
			// (endpointOai.ts:96-98): the router's own header wins, the completion body's `model` is the
			// fallback for hosts that send no header.
			const body = (await res.json().catch(() => null)) as { model?: string } | null;
			cap.served = {
				model: res.headers.get("X-Router-Model") || body?.model || undefined,
				provider: res.headers.get("x-inference-provider") || undefined,
				// RECORDED, not asserted. On the LiteLLM gateway `body.model` only echoes the requested
				// model_group, so the identity check below can confirm the request was routed as asked and
				// still not name the machine that answered. This header does name it, and it is the one
				// field that makes a served-model substitution visible in a log search rather than only
				// in a chat badge nobody reads. Asserting it needs an expected-backend to compare
				// against, which is config we do not have yet; carrying it costs nothing and makes the
				// question answerable from Axiom today.
				backend: res.headers.get("x-litellm-model-api-base") || undefined,
				// Whether the gateway answered from its response cache rather than a model. LiteLLM sets
				// `x-litellm-cache-key` on a cache hit, and a hit still reports a backend, so `backend` alone
				// cannot tell the two apart. A fixed probe prompt is a hit every time (CUR-2242); this makes "every probe reached a model" a query rather than an inference.
				cached: res.headers.has("x-litellm-cache-key"),
			};
			// The verdict for THIS leg is reachability alone — a response came back OK. Identity is a
			// separate, deliberately independent probe below (model:identity); this leg does not weigh in
			// on it.
			return true;
		},
		() => ({
			lane: lane.name,
			model: id,
			backend: cap.served?.backend,
			cached: cap.served?.cached,
			...(cap.busy ? { busy: true } : {}),
		})
	);
	// Recording nothing leaves the failure count where it was, so three real failures still fire across
	// any number of busy answers between them (alerting.ts: "a skipped probe records nothing"). A full
	// limit that makes real turns fail outright shows in turn:outcome-rate. One that only moves them to
	// the backup model raises no alert anywhere.
	if (cap.busy) return;
	// The primary model is total-failure tier (no model, no answer) and, unlike the moderation leg, this
	// `ok` is honest — so it is the one warm leg that can carry an alert. Same debounce/delivery as the
	// Coop probe: 3 consecutive failures before firing, which at the 30s throttle under the 60s cron is
	// ~3 min for a sustained failure and never for an isolated blip (timeouts spread hours apart do not fire).
	await recordProbe("model:warm", ok, {
		label: "Served model endpoint",
		runbook:
			lane.name === "mistral"
				? `No model ⇒ no answer: every turn on the default model fails, since no picked model fails over to another (CUR-3936). The primary (${id}) is served through MISTRAL_CHAT_BASE_URL, the staging router (CUR-2928), not OPENAI_BASE_URL. Read the [warm] leg line's err and backend, then send one unique-prompt completion to that host with MISTRAL_CHAT_API_KEY and read the status: a 401/403 is the key, a 429 is the router's per-minute limit, a 5xx or timeout is the router or Mistral behind it. That host is the router operator's; La Plateforme's own key was retired on 2026-10-11, so pointing back at it is no rollback. MODEL_ALLOWLIST no longer chooses the picker on Vercel. The rollback is a code change: add the default to WITHDRAWN in web/config/picker.ts, which makes the next model in the list the default, and ship it to main as a hotfix. Auto already skips a model the busy mark has caught, with no deploy (modelBusy.ts).`
				: `No model ⇒ no answer: every turn fails. Check OPENAI_BASE_URL/OPENAI_PROVIDER and that MODEL_ALLOWLIST still names a served checkpoint — a CSCS rotation is the failure we have actually seen (CUR-73), and it presents as this leg going red with the gateway itself healthy. Confirm against the gateway's own catalog (\`GET $OPENAI_BASE_URL/models\`) before changing anything: an allowlist naming nothing in the live catalog fails loud by design and does NOT widen to the full catalog. There is one lane now (CUR-243 collapsed the Apertus 1.5 substitution), so \`lane=${lane.name}\` is informational — if it ever reads anything else, a substitution came back and this probe needs to follow it.`,
	});

	// ── Served-model IDENTITY, asserted separately from reachability ──────────────────────────────
	// The leg above answers "is a model answering". It cannot answer "is it OUR model", and that gap is
	// real: a backup lane can serve a different model while this leg reports ok=true on every probe, and
	// no check goes red. The chat badge names the served model correctly, and no operator reads the badge.
	//
	// Deliberately its OWN probe key, not folded into model:warm: a silent model substitution is a
	// truthfulness failure for a public-AI project, not a failure, and it needs a runbook that points at
	// the gateway rather than at the endpoint. Alerting is skipped when the host reports no provenance —
	// absent evidence must not read as a mismatch (that would be the fail-open trap inverted) — but
	// skipping the log line too would make that skip indistinguishable, from Axiom, from a clean
	// multi-day run of matches: a search for `leg: "model-identity"` returning zero rows would be equally
	// consistent with "quietly fine" and "not running" (CUR-1200). So every branch logs, and only the
	// verdict-bearing branch pages (recordProbe's own doc comment: "a skipped probe records nothing";
	// that contract still holds, it just does not mean "and says nothing either").
	const seen = cap.served;
	if (ok) {
		// Compare the BASE ids. Our request carries a `:provider` pin (providerPin.ts:24) that the
		// response never echoes, so strip it; case is not meaningful across registries.
		//
		// `id` and not the allowlist entry, deliberately: `id` is what went out on the wire on whichever
		// lane resolveWarmLane picked. With one lane those are the same string once the `:provider`
		// suffix is stripped — but reading the wire id is what keeps this honest if a second lane ever
		// returns, and a constant here would stay green about a lane nobody is on.
		// A name in SERVED_AS is the same weights from another host (CUR-4343), so it matches too.
		const base = (s: string) => s.split(":")[0].trim().toLowerCase();
		const expected = base(id);
		if (seen?.model) {
			const actual = base(seen.model);
			const matches = sameServedModel(id, seen.model);
			const fields = {
				leg: "model-identity",
				ok: matches,
				lane: lane.name,
				expected,
				actual,
				provider: seen.provider,
				backend: seen.backend,
			};
			if (matches) {
				logger.info(fields, "[warm] served model matches the one this lane asked for");
			} else {
				logger.warn(
					fields,
					"[warm] served model is NOT the one this lane asked for — a backup lane is answering for it"
				);
			}
			await recordProbe("model:identity", matches, {
				label: "Served model matches the one the live lane requests",
				runbook:
					"A DIFFERENT model is answering than the one requested and advertised. Not an outage — the endpoint is healthy, it is serving someone else's checkpoint via a backup lane. CUR-874 wires the substitution through to routerMetadata, so the provenance badge and [turn] outcome now name the model that actually served. Read `lane` and `backend` off the [warm] leg line first: `backend` (x-litellm-model-api-base) names the machine that actually answered, which the model id alone cannot. Then check the upstream gateway's lane weights, then MODEL_ALLOWLIST, then any per-lane `modelId` override in MODELS. A backup lane can serve under the requested model's name with no other visible sign, which is why this check runs every warm cycle (CUR-113).",
			});
		} else {
			// Reachable, but neither X-Router-Model nor body.model came back — identity is UNKNOWN this
			// cycle, not asserted true or false, so no recordProbe (see the doc comment above). Logged
			// anyway: silence in Axiom would otherwise be indistinguishable from a clean run.
			logger.warn(
				{ leg: "model-identity", ok: null, lane: lane.name, expected },
				"[warm] served model identity UNKNOWN this cycle — response carried no X-Router-Model header and no body.model, cannot assert"
			);
		}
	}
}

// ── Picker model probes (CUR-4042) ───────────────────────────────────────────────────────────────
// The model leg above warms and checks the primary only. Every other model in the picker was known to
// be down only once three visitors had failed on it. modelProbe.ts probes each one every few minutes and
// sets or clears its busy mark from the result. This guard keeps a burst of page-load pings on one
// instance to one tick a minute; the per-model claim in modelProbe.ts is what holds across instances.
let lastProbeTickMinute = -1;

/** The models a visitor can pick: listed, not the agent, not the Auto router alias, not a local one. */
async function pickerProbeTargets(): Promise<ProbeTarget[]> {
	const { models, isSelectableModel } = await import("$lib/chat/server/models");
	return models.filter((m) => isSelectableModel(m) && !m.isRouter && !m.localEndpointKind);
}

/** Probe the picker models due on this minute (modelProbe.ts). Never throws. */
async function warmModelProbes(): Promise<void> {
	const minute = Math.floor(Date.now() / 60_000);
	if (minute === lastProbeTickMinute) return;
	lastProbeTickMinute = minute;
	try {
		await probeDueModels(await pickerProbeTargets());
	} catch (e) {
		logger.warn({ leg: "model-probe", err: e instanceof Error ? e.message : String(e) }, "[warm] leg");
	}
}

const EMBED_WARM_THROTTLE_MS = 30_000;
let lastEmbedWarmAt = 0;

// A stable, human-meaningful chunk to probe with; falls back to chunks[0] so a re-index that drops the
// id degrades to "still asserts identity" rather than to "silently stops asserting".
const EMBED_PROBE_CHUNK_ID = "policy.delete-data";
// Far above the 0.489 a same-dimension sibling model scored against this index in prod, and far below
// any float noise on the identical model (measured 1.000000). See the identity block in warmEmbeddings.
const EMBED_IDENTITY_MIN_COSINE = 0.99;

/** Wake the embeddings endpoint (HF feature-extraction). RAG grounding, the hedge/denial detector, and
 *  the intent classifier all embed through it — a cold endpoint adds a first-use stall (on the hot path
 *  for the classifier, post-stream for the hedge strip). One tiny memoized embed keeps it hot per
 *  instance; best-effort + throttled, identical posture to warmModel. */
export async function warmEmbeddings(): Promise<void> {
	const now = Date.now();
	if (now - lastEmbedWarmAt < throttleMs(EMBED_WARM_THROTTLE_MS)) return;
	lastEmbedWarmAt = now;
	// Generous timeout (vs embedText's 6s default): the warm runs in the background, and its whole
	// job is to absorb a cold endpoint's wake — a 6s abort means a cold serverless lane never finishes
	// warming (an AbortError on every warm run while the endpoint sleeps).
	// timedWarm logs [warm] leg=embeddings ok=… each cycle. Logging alone surfaces a failing leg only
	// when someone reads the logs, hence the identity probe below.
	// Warm by embedding a REAL indexed chunk rather than the string "warm": one call does both jobs, so
	// the identity assertion below costs nothing extra. Asserted against the committed index itself, not
	// a copied fixture — a fixture would be a second source of truth that can drift from the artifact
	// retrieval actually reads.
	const probe = ragIndex.chunks.find((c) => c.id === EMBED_PROBE_CHUNK_ID) ?? ragIndex.chunks[0];
	const cap: { vec: number[] | null } = { vec: null };
	// embedText FAILS OPEN internally — a non-OK response, an unexpected shape, or a network error all
	// resolve to `null` rather than throwing (embed.ts). So the real verdict here is whether a vector
	// actually came back, not whether the call resolved (CUR-114: under the old timedWarm, every one of
	// those failure modes logged ok=true because nothing threw).
	const ok = await timedWarm("embeddings", async () => {
		cap.vec = await embedText(probe?.text ?? "warm", 15_000);
		return cap.vec !== null;
	});
	// DEGRADED, not down: every consumer of embeddings fails OPEN (localitySemantic, semanticHedge,
	// guardVectors, queryRewrite all fall back to regex/raw), so turns keep answering.
	await recordProbe("embeddings:warm", ok, {
		label: "RAG embeddings endpoint",
		severity: "degraded",
		runbook:
			"Turns still answer — every embeddings consumer fails open to regex/raw, so the cost is worse retrieval and a dead semantic hedge, not an outage. Check the HF Inference Endpoint (min-replicas=1) and HF_RAG_EMBEDDINGS_TOKEN.",
	});

	// ── Embedding-space IDENTITY, the same gap the model leg had ──────────────────────────────────
	// "The endpoint answered" says nothing about WHICH model answered, and here that distinction is
	// invisible by construction: prod resolves through RAG_EMBEDDING_ENDPOINT_URL, a dedicated HF
	// Inference Endpoint whose served model is set in the HF console — NOT by RAG_EMBEDDING_MODEL. So
	// `check:rag-index`, which compares idx.model to RAG_EMBEDDING_MODEL, compares what we asked for to
	// what we asked for and cannot see a swap at all.
	//
	// Measured against prod, which is why this asserts cosine and not shape. Same chunk, three models,
	// all dim 384, and every shape assertion we own passes for all three:
	//   all-MiniLM-L6-v2 (the index's own model)   cosine 1.000000
	//   BAAI/bge-small-en-v1.5                     cosine 0.216
	//   paraphrase-MiniLM-L6-v2                    cosine 0.489   ← ABOVE RAG_MIN_SCORE (0.35)
	// That last one is the dangerous case: swap in a sibling model and retrieval keeps returning chunks,
	// scores keep clearing the tuned floor, and answers keep looking grounded while being ranked in a
	// different vector space. Quietly wrong rather than down, the same shape as a model swap on the chat
	// lane (CUR-113). The 0.99 floor is far above the 0.489 near-miss and far below any plausible float
	// noise on an identical model.
	const vec = cap.vec;
	if (ok && vec && probe) {
		const score = cosine(vec, probe.vector);
		const matches = score > EMBED_IDENTITY_MIN_COSINE;
		// Both outcomes are logged: with mismatches only, an Axiom search for `leg: "embeddings-identity"`
		// returning zero rows would read the same for "quietly fine" and "not running" (CUR-1200).
		const fields = { leg: "embeddings-identity", ok: matches, chunk: probe.id, cosine: score, indexModel: ragIndex.model };
		if (matches) {
			logger.info(fields, "[warm] embedding endpoint is in the committed index's vector space");
		} else {
			logger.warn(
				fields,
				"[warm] embedding endpoint is NOT in the committed index's vector space — retrieval is quietly wrong"
			);
		}
		await recordProbe("embeddings:identity", matches, {
			label: "Embeddings match the committed index",
			severity: "degraded",
			runbook:
				"The endpoint is healthy but answering in a DIFFERENT vector space than data/rag-index.json was built with, so retrieval ranks in the wrong geometry and RAG_MIN_SCORE no longer means what it was tuned to mean. Note check:rag-index cannot catch this: prod resolves through RAG_EMBEDDING_ENDPOINT_URL and that gate only compares RAG_EMBEDDING_MODEL. Check the served model in the HF Inference Endpoint console, then rebuild with `pnpm build:rag-index` if the change was intended.",
		});
	}
}

// DB connection cold-start is Neon-pooler latency, not compute: db/client.ts connects lazily on the
// first query, and its own comment notes the pooler handshake was slow enough to trip the default
// connect timeout on a fresh function (now raised to 30s). postgres.js reaps the connection after
// PG_IDLE_TIMEOUT (default 150s, above the 60s warm-cron cadence so the cron sustains the connection;
// a reap window shorter than the cadence makes every between-cron first query pay the pooler connect).
// The tighter 15s throttle here is kept so rapid client pings (load/focus) refresh liveness cheaply
// without a stampede of `select 1`s.
//
// ⚠️ COUPLED, ENFORCED NOWHERE: PG_IDLE_TIMEOUT (env, unset in prod → the 150s default in
// db/client.ts) and the cron interval (`* * * * *` in vercel.json) constrain each other. The cron must
// fire well inside the reap window or this leg stops sustaining anything — silently: no test fails and
// nothing warns, the `db` leg just starts paying the pooler connect. 60s is the coarsest cron-expressible
// interval that still survives ONE missed run (2 × 60 < 150). Change either side and re-check the other.
// Over 24h of production (Axiom) the db leg ran 4.6ms avg / 96ms max over 1,582 runs, with no missed
// cron runs (CUR-30 for the queries, CUR-47 for the interval).
const DB_WARM_THROTTLE_MS = 15_000;
let lastDbWarmAt = 0;

/** Wake (or keep alive) the lazy Postgres connection with the cheapest possible round trip. Without
 *  this, the FIRST real query of a cold/idle-reaped function pays the full Neon pooler connect cost
 *  serially on the request's critical path, before the client ever sees a byte. */
export async function warmDb(): Promise<void> {
	const now = Date.now();
	if (now - lastDbWarmAt < throttleMs(DB_WARM_THROTTLE_MS)) return;
	lastDbWarmAt = now;
	// timedWarm logs [warm] leg=db ok=… and swallows (warmDb stays best-effort). Liveness is the right
	// verdict for a connection (schema state is db:drift's job in CI, not this leg's) — a resolved query
	// IS the verdict, so this only makes it an explicit boolean rather than the query result object.
	const ok = await timedWarm("db", async () => {
		await getDb().execute(sql`select 1`);
		return true;
	});
	// Total-failure tier: no persistence, no history. NOTE the self-reference — recordProbe's own state
	// lives in Postgres, so a genuine DB failure means the probe cannot record or debounce either. It
	// swallows and logs rather than throwing (alerting is best-effort), so this leg degrades to the
	// Axiom line it already emitted. Accepted: a DB-independent alert path is a bigger build than the
	// failure justifies, and the model/Coop probes are unaffected.
	await recordProbe("db:warm", ok, {
		label: "Postgres (Neon)",
		runbook:
			"No persistence ⇒ no conversation history and no rate-limit accounting (which fails OPEN). Check the Neon pooler and DATABASE_URL. If the DB is truly down this alert may not have fired at all — its own state row lives there.",
	});
}

/** Re-check the model registry's flag-derived gates (picker/router-alias/agent-mode) every cron tick,
 *  and republish only on a real change (CUR-1149). `ensureModelsReady` builds the registry once per
 *  process and never again — this is what stops a flag flip from being invisible for the rest of that
 *  process's life, which in practice can span more than one deploy (CUR-1122). No throttle: cheap when
 *  nothing changed (one flag poll), and a real flip is exactly the case this exists to catch promptly.
 *
 *  This is the only leg that imports from `models.ts`. It logs as designed under `pnpm dev`, but on
 *  Vercel it has not been seen to log (success, failure or error) while every sibling leg in the same
 *  Promise.allSettled fires. The suspected cause is the adapter-vercel function-bundling gap the route's
 *  own header comment describes, not this function. */
export async function warmRegistryGates(): Promise<void> {
	const cap: { result: Awaited<ReturnType<typeof refreshRegistryGatesIfChanged>> | null } = {
		result: null,
	};
	await timedWarm(
		"registry-gates",
		async () => {
			cap.result = await refreshRegistryGatesIfChanged();
			return true;
		},
		() => (cap.result ? { changed: cap.result.changed, ...cap.result.gates } : {})
	);
}

// SyftHub pre-flight router CATALOG cold-start. When the router runs, each turn reads the data-source
// catalog (hub.browse) to reason over it; getSyftCatalog caches that for RAG_ROUTER_CATALOG_TTL_MS (1h)
// per instance, but the FIRST federated turn on a cold instance still pays the extra round-trip
// (syftCatalogMs) serially before generation. Warming it off-turn fills that in-memory cache ahead of
// the user. Throttled at 30s like the model/embeddings legs (the 1h TTL means re-calls are cache hits
// anyway — the throttle only guards against a concurrent double-browse on a cold instance).
const CATALOG_WARM_THROTTLE_MS = 30_000;
let lastCatalogWarmAt = 0;

/** Populate the SyftHub router catalog (hub.browse) in this instance's in-memory 1h cache off-turn so
 *  the first federated turn doesn't pay the extra round-trip on its critical path. GATED to the router
 *  path: with the router neither enabled NOR shadowing, the catalog is never consulted (warming it would
 *  spend a round-trip for nothing); with no SyftHub token there's no client to browse. Best-effort +
 *  throttled, identical posture to warmModel. syftCatalog (which pulls in @syfthub/sdk) is imported
 *  DYNAMICALLY so warm.ts's static graph (and the hermetic warm tests)
 *  never load the SDK when the router is off. */
export async function warmSyftCatalog(): Promise<void> {
	const r = syftRouter();
	if (!(r.enabled || r.shadow)) return; // router off ⇒ catalog never consulted
	if (!syftEnabled()) return; // no token ⇒ no client ⇒ nothing to warm
	const now = Date.now();
	if (now - lastCatalogWarmAt < throttleMs(CATALOG_WARM_THROTTLE_MS)) return;
	lastCatalogWarmAt = now;
	const getSyftCatalog = await import("$lib/chat/server/rag/syftCatalog")
		.then((m) => m.getSyftCatalog)
		.catch(() => undefined);
	if (!getSyftCatalog) return;
	// getSyftCatalog FAILS OPEN internally, same shape as embedText: client-acquisition failure, an
	// aborted browse, and an upstream error all resolve to `null` rather than throwing (syftCatalog.ts).
	// So the real verdict is whether a catalog actually came back, not whether the call resolved
	// (CUR-114) — timedWarm logs [warm] leg=catalog ok=… ms=… and swallows (warmSyftCatalog stays
	// best-effort).
	const ok = await timedWarm("catalog", async () => (await getSyftCatalog()) !== null);
	// DEGRADED: the catalog only feeds the pre-flight router's reasoning; without it a turn answers
	// unrouted. Dormant in prod while the router gate above returns before this line (no `leg=catalog`
	// events in prod Axiom). Wiring it now means enabling the router brings its alerting along.
	await recordProbe("catalog:warm", ok, {
		label: "SyftHub router catalog",
		severity: "degraded",
		runbook:
			"Only the pre-flight router consults it; turns answer unrouted without it. Check syfthub.openmined.org and SYFTHUB_API_TOKEN.",
	});
}

/** Read Mistral's model list on a deployment with a Mistral lane, and alert when it can't be read
 *  (CUR-3842). That list is how an answer's `*-latest` alias is credited to its dated version; when it
 *  is unreadable every Large 3 answer is badged with the alias, with only an error log line to show
 *  for it (CUR-3841). */
const MISTRAL_VERSIONS_THROTTLE_MS = 600_000;
let lastMistralVersionsAt = 0;
export async function warmMistralVersions(): Promise<void> {
	const now = Date.now();
	if (now - lastMistralVersionsAt < throttleMs(MISTRAL_VERSIONS_THROTTLE_MS)) return;
	lastMistralVersionsAt = now;
	const read = await probeMistralModelList().catch(() => false);
	if (read === null) return; // no Mistral lane here, nothing to verify
	const lane = mistralChatLane();
	logger[read ? "info" : "warn"](
		{ leg: "mistral-versions", ok: read, lane: lane.keyEnv, ms: Date.now() - now },
		"[warm] leg"
	);
	await recordProbe("mistral:versions", read, {
		label: "Mistral model list (answer versions)",
		severity: "degraded",
		runbook:
			"Answers still arrive, but every Mistral answer is credited to the router's `*-latest` alias in place of its dated version. mistralVersions.ts reads the list from the router's `/mistral/v1/models` passthrough (behind a Folkways adapter, from FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL), then La Plateforme on MISTRAL_BASE_URL. Curl that URL with MISTRAL_CHAT_API_KEY and read the status before changing anything.",
	});
}

// Coop VERDICT-path HEALTH probe — distinct from the `moderation` warm leg, which swallows and is ALWAYS
// ok (see CUR-35). This leg reports REAL health: probeCoopHealth runs a benign verdict through the live
// path and is healthy iff Coop returns a non-UNKNOWN verdict — UNKNOWN is the exact state that fail-CLOSES
// real turns into CHILD_SAFETY_DECLINE (the invisible "assistant refusing users" failure). Feeds
// alerting.recordProbe → the alert_state debounce → the alert channel. THROTTLED well above the 60s cron cadence: the
// probe costs a real Coop rule evaluation (the reason warming dropped /content), so ~3 min keeps it a few
// evals/hour; with alerting's FIRE_THRESHOLD=3 that's ~9 min to fire — fast for a failure, past a blip.
// Skipped entirely when Coop isn't configured (probeCoopHealth → null). NOT wrapped in timedWarm: `ok`
// here is the PROBE VERDICT, not "the work completed" (timedWarm's ok would always be true, the exact
// trap this leg exists to avoid).
const COOP_HEALTH_THROTTLE_MS = 180_000;
let lastCoopHealthAt = 0;
const COOP_ALERT_RUNBOOK =
	"checkChildSafety fails CLOSED on this ⇒ every turn declines as CHILD_SAFETY_DECLINE (looks like the model refusing users, not an outage). Check the Coop service at COOP_URL; if confirmed down, weigh disarming child-safety per moderation.ts.";

export async function warmCoopHealth(): Promise<void> {
	// Under guard-primary Coop is the REVIEW plane, not a detector, so the /content VERDICT probe would
	// be Coop-as-detector receiving non-hit content — and recordProbe("coop:verdict", …) would alert on a
	// path no longer in use. Suppress it; the rule-free origin ping (warmModeration → pingCoopOrigin)
	// stands in as review-service reachability. Flag OFF keeps the verdict probe — Coop IS the live gate
	// then, and warmGuardHealth watches the guard side.
	if (guardPrimaryEnabled()) {
		await warmModeration();
		await warmCoopReviewConfig();
		return;
	}
	const now = Date.now();
	if (now - lastCoopHealthAt < throttleMs(COOP_HEALTH_THROTTLE_MS)) return;
	lastCoopHealthAt = now;
	const start = Date.now();
	const healthy = await probeCoopHealth(); // null ⇒ Coop not configured ⇒ nothing to watch, skip
	if (healthy === null) return;
	logger.info({ leg: "coop", ok: healthy, ms: Date.now() - start }, "[warm] leg");
	await recordProbe("coop:verdict", healthy, {
		label: "Coop verdict path",
		runbook: COOP_ALERT_RUNBOOK,
	});
}

// Under guard-primary, Coop is where detection hits and CSAM hash matches go for human review. Its
// keys missing on a deployment means those reports are dropped with one log line, so alert on it.
// Config only, no network call; off a deployment there is nothing to watch.
let lastCoopReviewConfigAt = 0;
async function warmCoopReviewConfig(): Promise<void> {
	if (!isDeployment()) return;
	const now = Date.now();
	if (now - lastCoopReviewConfigAt < throttleMs(COOP_HEALTH_THROTTLE_MS)) return;
	lastCoopReviewConfigAt = now;
	const missing = coopReviewConfigMissing();
	logger.info({ leg: "coop-review-config", ok: missing.length === 0, missing }, "[warm] leg");
	await recordProbe("coop:review-config", missing.length === 0, {
		label: "Coop review config",
		runbook: `${missing.join(", ") || "nothing"} unset: Shieldstral detection hits and CSAM hash matches are not reaching Coop's review queue. Restore the keys in Doppler for this config and redeploy.`,
	});
}

// GUARD verdict-path health probe — the guard-primary twin of
// warmCoopHealth, watching the SAME failure class: an UNKNOWN screen fail-CLOSES child safety, so a
// dead/wrong guard endpoint presents as the assistant refusing users, not as a failure. One probe,
// two fixtures (benign must screen safe; a fixed violative line that must block on chat-block-violence,
// exercising stage 2) through the real screening path (probeGuardHealth): transport, parse, and SERVED
// MODEL IDENTITY asserted on EVERY response — reachability is not identity (CUR-113: a healthy endpoint
// can serve someone else's checkpoint while every probe stays green).
//
// Runs when the guard verdict path is live for EITHER consumer: the
// guard-primary FLAG (chat turns screen through the guard) OR safetyScreenConfigured() (the agent
// service screens through POST /chat/api/safety/screen, regardless of the flag — its own deploy arms
// SAFETY_SCREEN_TOKEN). Either way the same probe (transport, parse, served-model IDENTITY on every
// response) watches the SAME failure class — an UNKNOWN screen fail-CLOSES, so a dead/wrong endpoint
// presents as chat refusing users (child-closed) or agent tasks 502-ing, not as a failure. The URL
// unset while a consumer is live is the plan's loud misconfiguration — recorded UNHEALTHY here, never a
// silent skip. Neither consumer live ⇒ no probe (the Coop leg above is the live-gate watcher then).
const GUARD_HEALTH_THROTTLE_MS = 180_000;
let lastGuardHealthAt = 0;
const GUARD_ALERT_RUNBOOK =
	"The guard gate (Shieldstral-1.0-3B) fail-CLOSES child safety on UNKNOWN ⇒ every turn declines as CHILD_SAFETY_DECLINE (looks like the model refusing users). The HF endpoint at GUARD_SHADOW_URL is configured to NEVER scale to zero (min replicas ≥1), so a 503/UNKNOWN here is a REAL endpoint fault (replica restart, overload, or outage), NOT a scale-to-zero wake window — check the HF endpoint dashboard, then the served model identity in this leg's log line. Kill switch guard-primary OFF recovers CHAT only. The agent service screens through /chat/api/safety/screen regardless of the flag — restore the HF endpoint (or its GUARD_SHADOW_URL) to recover agent moderation; until then agent tasks fail closed (502).";

export async function warmGuardHealth(): Promise<void> {
	if (!guardPrimaryEnabled() && !safetyScreenConfigured()) return;
	const now = Date.now();
	if (now - lastGuardHealthAt < throttleMs(GUARD_HEALTH_THROTTLE_MS)) return;
	lastGuardHealthAt = now;
	const start = Date.now();
	if (!guardPrimaryConfigured()) {
		logger.error(
			{ leg: "guard", ok: false },
			"[warm] the guard verdict path is live (guard-primary flag and/or the agent screen endpoint) but GUARD_SHADOW_URL is unset — screens fail UNKNOWN (chat child-closed / agent 502) on every turn"
		);
		void captureServerException(
			new Error("GUARD_SHADOW_URL unset while the guard verdict path is live")
		);
		await recordProbe("guard:verdict", false, {
			label: "Guard gate (Shieldstral-1.0-3B) verdict path",
			runbook: GUARD_ALERT_RUNBOOK,
		});
		return;
	}
	const probe = await probeGuardHealth();
	if (probe === null) return; // unreachable given the configured check above
	logger.info(
		{
			leg: "guard",
			ok: probe.healthy,
			transportOk: probe.transportOk,
			parseOk: probe.parseOk,
			identityOk: probe.identityOk,
			identityAsserted: probe.identityAsserted,
			servedModels: probe.servedModels,
			ms: Date.now() - start,
		},
		"[warm] leg"
	);
	// NB an endpoint that reports NO model id (on any call) records UNHEALTHY (identityAsserted:false in
	// the leg line names the reason): this probe is the guard's ONLY identity assertion, so "absent ⇒
	// green" would let a substituted endpoint hide forever by stripping the field. See probeGuardHealth.
	await recordProbe("guard:verdict", probe.healthy, {
		label: "Guard gate (Shieldstral-1.0-3B) verdict path",
		runbook: GUARD_ALERT_RUNBOOK,
	});
}

// Fail-closed child-safety decline rate: the one signal that catches turns being declined while the
// app, model and DB are all up. When Coop returns UNKNOWN, checkChildSafety fails closed, so a decline
// is what the caller sees; one such episode can decline thousands of turns over days with nothing red. See
// countFailClosedChildDeclines for the discriminator.
//
// This is NOT the Coop verdict probe (warmCoopHealth). That probe asks "can Coop answer ME right now"
// with benign text; this one asks "is the live traffic being declined". They fail independently: the
// probe can read healthy while real turns fail closed, and it is blind to a dead detector entirely
// (CUR-83). Two different questions, deliberately both asked.
//
// Unlike the other probes, this one is NOT subject to CUR-90's per-instance counter race: every
// instance queries the same shared table over the same window, so they all compute the same answer and
// a healthy instance cannot mask an unhealthy one. The throttle below is still per-instance, so the
// COUNT runs once per instance per window — a cheap indexed count, deliberately accepted.
//
// Thresholds from the measured distribution. Steady state for this predicate is zero, and a Coop
// outage produces about 250 declines per 15 minutes. So 5-in-15-minutes sits in a gap three orders of
// magnitude wide: an isolated UNKNOWN never fires, and an outage crosses within one window.
const DECLINE_PROBE_THROTTLE_MS = 5 * 60_000;
const DECLINE_WINDOW_MS = 15 * 60_000;
const DECLINE_THRESHOLD = 5;
let lastDeclineProbeAt = 0;
const DECLINE_ALERT_RUNBOOK =
	"Users are being REFUSED, not served — checkChildSafety fails CLOSED on an UNKNOWN Coop verdict, so this is an outage wearing a moderation costume and no other signal will be red. Check the Coop service at COOP_URL and the Zentropi detector; if Coop is confirmed down, weigh disarming child-safety per moderation.ts.";

/** Alert when real users start hitting the fail-CLOSED child-safety path. Throttled well above the
 *  60s cron: this is a DB count, and the signal is a sustained rate rather than a single turn. */
export async function warmDeclineRate(): Promise<void> {
	const now = Date.now();
	if (now - lastDeclineProbeAt < throttleMs(DECLINE_PROBE_THROTTLE_MS)) return;
	lastDeclineProbeAt = now;
	let n: number;
	try {
		n = await countFailClosedChildDeclines(DECLINE_WINDOW_MS);
	} catch (e) {
		// Can't read the table ⇒ report NOTHING rather than a healthy zero. A failed count that recorded
		// "healthy" would be the same always-green trap this probe exists to close.
		logger.warn(
			{ err: e instanceof Error ? e.message : String(e) },
			"[warm] leg=declines count failed — no probe recorded"
		);
		return;
	}
	const healthy = n < DECLINE_THRESHOLD;
	logger.info({ leg: "declines", ok: healthy, n, windowMs: DECLINE_WINDOW_MS }, "[warm] leg");
	await recordProbe("moderation:failclosed", healthy, {
		label: "Child-safety fail-closed declines",
		runbook: DECLINE_ALERT_RUNBOOK,
	});
}

// Errors per warm tick (~60s) before this is unhealthy. Deliberately not 1: a single 500 from one
// malformed request is noise, and an alert that fires on noise gets muted. Sustained errors are the
// signal. Tune from the first week of real numbers rather than guessing harder now.
const ERROR_RATE_THRESHOLD = 5;
const ERROR_ALERT_RUNBOOK =
	"Unhandled server exceptions are firing at a sustained rate — OUR code, not a vendor, so no dependency probe will be red. Group them in PostHog error tracking (captureServerException tags each with error_id and route_id), then check Axiom for the full structured context on one error_id.";

/** Alert on unhandled server exceptions. Every other probe watches a DEPENDENCY; this is the only one
 *  watching our own code, where a failure can come from with every dependency green. Reads and resets the
 *  in-process counter, so the value is a rate over one cron tick.
 *
 *  Reports EVERY tick, including zero — a healthy probe is what clears a firing alert and posts the
 *  recovery line. */
export async function warmErrorRate(): Promise<void> {
	const n = takeErrorCount();
	const healthy = n < ERROR_RATE_THRESHOLD;
	logger.info({ leg: "errors", ok: healthy, n }, "[warm] leg");
	await recordProbe("errors:rate", healthy, {
		label: "Unhandled server exceptions",
		runbook: ERROR_ALERT_RUNBOOK,
	});
}

// The auto-route classifier fails open (answers normally, agent mode silently never engages) rather
// than throwing, so warmErrorRate's own counter never sees it — a person in agent mode can't tell "the
// router decided no tool was needed" from "the router fell over", and without a count the failures are
// only scattered `[agent-route]` warn lines (CUR-1260). There is no steady-state baseline yet, so the
// threshold is conservative and is tuned from observed rates.
const AGENT_ROUTE_FAILURE_THRESHOLD = 5;
const AGENT_ROUTE_FAILURE_RUNBOOK =
	"The agent-mode auto-route classifier (POST /route on the agent service) is failing at a sustained " +
	"rate and every failure falls open to 'answer normally' — CUR-671's 'agent mode rarely reaches for a " +
	"tool' finding may be this, not a model preference. Check Axiom for `[agent-route]` warn lines; each " +
	"now carries a `reason` (http_error | timeout | network | parse_error | unknown) instead of a raw " +
	"error blob. `timeout`/`network` point at the agent service being slow or unreachable; `http_error` " +
	"points at a bad deploy there; `parse_error` means it answered with something that isn't the expected " +
	"JSON shape.";

/** Alert on the auto-route classifier's fail-open rate. Same shape as warmErrorRate: reads and resets
 *  an in-process counter kept in resolveAgentRoute.ts itself (not errorTracking.ts's generic exception
 *  counter — this is an intentional fallback path, not an unhandled throw, and conflating the two rates
 *  would hide either signal inside the other). */
export async function warmAgentRouteFailureRate(): Promise<void> {
	const n = takeAgentRouteFailureCount();
	const healthy = n < AGENT_ROUTE_FAILURE_THRESHOLD;
	logger.info({ leg: "agent-route", ok: healthy, n }, "[warm] leg");
	await recordProbe("agent-route:failure-rate", healthy, {
		label: "Agent auto-route classifier failures",
		runbook: AGENT_ROUTE_FAILURE_RUNBOOK,
	});
}

// ── Turn-outcome RATE (CUR-89) ───────────────────────────────────────────────────────────────────
// The probes above each watch a failure someone predicted: a dead vendor, a thrown exception, a Coop
// failure. None answers "what fraction of REAL turns did not produce an answer, for a reason not on the
// list". warmErrorRate catches unhandled throws, but a turn can end empty WITHOUT throwing — for example
// a turn that times out on an unclosed <think> while generations.status records it `complete`. This reads the
// terminal-outcome taxonomy that only the turn route knows (persisted to turn_outcomes because the
// [turn] outcome log lives in Axiom, which the cron can't reach) and alerts on the failure RATE.
//
// FAILURE set: error + timedOut + empty — the turn broke, the watchdog killed it, or the model wrote
// nothing and a guard covered for it (CUR-445). It is DEFINED WITH THE LADDER, in
// $lib/chat/utils/outcomeLadder, not restated here: a second copy of the same taxonomy would need
// every new outcome value added in two places, and one missed would count as a success by omission. See there for what is excluded and why, and for the measurement behind `empty`.
const TURN_OUTCOME_PROBE_THROTTLE_MS = 5 * 60_000; // a DB read of a sustained rate; no need per 60s tick
// The window, sample floor, rate ceiling and the recovery rule live with the decision in
// turnOutcomeVerdict.ts, so a replay of real rows runs the same code as this cron (CUR-2242).
const TURN_OUTCOME_RETENTION_MS = 48 * 60 * 60_000;
const TURN_OUTCOME_RUNBOOK =
	"A sustained share of real turns ended without an answer (error/timedOut/empty) — OUR path, not a vendor, so no dependency probe will be red and the synthetic turn may still pass on its single shot. Check the [turn] outcome distribution in Axiom (break down by vercel.environment), then PostHog error tracking. If the excess is `empty` the pipeline is fine and the MODEL returned nothing: compare answerChars against modelChars on those turns — a large answerChars with modelChars 0 is the honesty guard's sources pointer standing in for a blank answer. child_safety declines and unhandled exceptions have their own probes; this is the everything-else rate.";
let lastTurnOutcomeProbeAt = 0;

/** Alert on the RATE of non-complete turn outcomes over a rolling window. Throttled well above the 60s
 *  cron: it's a DB aggregate of a sustained rate, not a single turn. Prunes the table each run so it
 *  stays bounded. */
export async function warmTurnOutcomeRate(): Promise<void> {
	const now = Date.now();
	if (now - lastTurnOutcomeProbeAt < throttleMs(TURN_OUTCOME_PROBE_THROTTLE_MS)) return;
	lastTurnOutcomeProbeAt = now;
	let counts: Record<string, number>;
	try {
		counts = await countTurnOutcomes(TURN_OUTCOME_WINDOW_MS);
	} catch (e) {
		// Can't read the table ⇒ record NOTHING, not a healthy zero — the always-green trap this exists
		// to close. Same posture as warmDeclineRate.
		logger.warn(
			{ err: e instanceof Error ? e.message : String(e) },
			"[warm] leg=turn-outcome count failed — no probe recorded"
		);
		return;
	}
	// Prune regardless of what the count said — an alerting table must not grow unbounded.
	void pruneTurnOutcomes(TURN_OUTCOME_RETENTION_MS).catch((e) =>
		logger.warn({ err: e instanceof Error ? e.message : String(e) }, "[warm] turn-outcome prune failed")
	);
	let verdict = turnOutcomeVerdict({
		counts,
		failureOutcomes: FAILURE_OUTCOMES,
		newestFailureAt: null,
		completesSinceFailure: 0,
		now: new Date(now),
	});
	if (verdict.kind === "failing") {
		// Over the ceiling on the 6h window. Read the newest evidence before re-raising, since the window
		// stays over for hours after answers complete again (CUR-2242). A failed read keeps the failing
		// verdict: missing evidence of recovery is not evidence of it.
		try {
			const recovery = await turnOutcomeRecovery(TURN_OUTCOME_WINDOW_MS, [...FAILURE_OUTCOMES]);
			verdict = turnOutcomeVerdict({
				counts,
				failureOutcomes: FAILURE_OUTCOMES,
				...recovery,
				now: new Date(now),
			});
		} catch (e) {
			logger.warn(
				{ err: e instanceof Error ? e.message : String(e) },
				"[warm] leg=turn-outcome recovery read failed — keeping the failing verdict"
			);
		}
	}
	if (verdict.kind === "no-verdict") {
		// No denominator worth alerting on. Skip rather than record — a healthy zero here would clear a
		// real firing alert the moment traffic dipped, and a raised one on 1/2 turns would be noise.
		logger.info(
			{ leg: "turn-outcome", ok: true, total: verdict.total, note: "below-min-sample" },
			"[warm] leg"
		);
		return;
	}
	const healthy = verdict.kind !== "failing";
	logger.info(
		{
			leg: "turn-outcome",
			ok: healthy,
			total: verdict.total,
			failures: verdict.failures,
			rate: Number(verdict.rate.toFixed(3)),
			...(verdict.kind === "recovered"
				? { note: "recovered", completesSinceFailure: verdict.completesSinceFailure }
				: {}),
		},
		"[warm] leg"
	);
	await recordProbe("turn:outcome-rate", healthy, {
		label: "Turn failure rate",
		runbook: TURN_OUTCOME_RUNBOOK,
	});
}

// ── first-token median (CUR-2243) ─────────────────────────────────────────────────────
// The rate probe above sees turns that end without an answer. A pool that still answers, slowly, ends
// every turn `complete` and reads healthy there; this reads how long the newest completed turns waited
// for their first words. The sample, window and ceiling live with the decision in turnSpeedVerdict.ts.
const TURN_SPEED_PROBE_THROTTLE_MS = 5 * 60_000;
const TURN_SPEED_RUNBOOK =
	"The newest completed turns waited a median of over 15s for their first words: answers are arriving, slowly. Check which model served them (`pnpm models:matrix`, then the persisted routerMetadata) and that lane's provider status; a burst of Large 3 → Medium fallbacks means Mistral is rate-limiting us. web/scripts/ttft-baseline.sh splits the wait by stage, to tell retrieval or screening apart from the model.";
let lastTurnSpeedProbeAt = 0;

/** Alert when the median time to first token of the newest completed turns is over the ceiling. Records
 *  nothing when the read fails or there are too few turns, so a firing alert stays firing until real
 *  turns say otherwise. */
export async function warmTurnSpeed(): Promise<void> {
	const now = Date.now();
	if (now - lastTurnSpeedProbeAt < throttleMs(TURN_SPEED_PROBE_THROTTLE_MS)) return;
	lastTurnSpeedProbeAt = now;
	let ttfts: number[];
	try {
		ttfts = await recentCompleteTtfts(TURN_SPEED_WINDOW_MS, TURN_SPEED_SAMPLE);
	} catch (e) {
		logger.warn(
			{ err: e instanceof Error ? e.message : String(e) },
			"[warm] leg=turn-speed read failed — no probe recorded"
		);
		return;
	}
	const verdict = turnSpeedVerdict(ttfts);
	if (verdict.kind === "no-verdict") {
		logger.info({ leg: "turn-speed", ok: true, total: verdict.total, note: "below-min-sample" }, "[warm] leg");
		return;
	}
	const healthy = verdict.kind === "healthy";
	logger.info(
		{ leg: "turn-speed", ok: healthy, total: verdict.total, medianTtftMs: Math.round(verdict.medianTtftMs) },
		"[warm] leg"
	);
	await recordProbe("turn:first-token-median", healthy, {
		label: "Time to first words",
		runbook: TURN_SPEED_RUNBOOK,
	});
}

/** Warm every cold-start-prone upstream in parallel — moderation (Coop), the model, the
 *  embeddings endpoint and the DB connection. Pinged by the CLIENT on load/focus (a
 *  best-effort head-start while the user reads/types) and by the every-minute Vercel cron (vercel.json,
 *  `* * * * *` — see the PG_IDLE_TIMEOUT coupling note above warmDb before changing it).
 *  For the cron to actually land, Vercel Deployment Protection needs "Protection Bypass for Automation"
 *  enabled in project settings — the cron hits the deployment's own *.vercel.app URL, which platform SSO
 *  otherwise 401s before the app ever runs. Deployment protection is the only gate on /api/warm.
 *  Dedicated always-warm HF Inference Endpoints (min-replicas=1)
 *  cover the embeddings lane regardless; see docs/setup-warm-embeddings-endpoint.md. All legs best-effort. */
export async function warmAll(): Promise<void> {
	// model/embeddings/db self-report via timedWarm inside each fn; wrap the externally-swallowing
	// moderation leg here so every warm outcome is one structured [warm] leg=… ok=… ms=… line. The
	// allSettled stays belt-and-braces — every leg already swallows on its own.
	await Promise.allSettled([
		// moderation swallows internally (CUR-35) and have no real verdict to give — timedWarm now
		// requires one explicitly, so `return true` states what was previously implicit: `ok` here means
		// "completed", not "healthy".
		timedWarm("moderation", async () => {
			await warmModeration();
			return true;
		}),
		warmModel(),
		warmModelProbes(),
		warmEmbeddings(),
		warmDb(),
		warmSyftCatalog(),
		warmMistralVersions(),
		warmCoopHealth(),
		warmGuardHealth(),
		warmDeclineRate(),
		warmErrorRate(),
		warmAgentRouteFailureRate(),
		warmTurnOutcomeRate(),
		warmTurnSpeed(),
		// The flag plane (CUR-86) is READ synchronously from a snapshot, and this is the only thing that
		// refreshes it — without it the snapshot silently reads its env fallback forever. `warmRegistryGates`
		// (CUR-1149) additionally re-derives+republishes the model REGISTRY on a real gate change, which the
		// bare call below can't do — but its own doc comment says its effect on Vercel is unconfirmed. Keep both rather than let one subsume the other (CUR-1164): this
		// leg is the only thing standing between a PostHog flip and `guard-primary` (100% in prod, the
		// safety-verdict kill switch) actually taking effect within a cron tick instead of a lambda recycle.
		refreshFlags(),
		warmRegistryGates(),
	]);

	// AFTER the work, deliberately. Pinging at the top would prove only that the function was invoked;
	// pinging here proves the cron ran AND got to the end. allSettled never rejects, so a failed leg
	// still reaches this line — which is correct: individual leg failures are reported by recordProbe,
	// and this signal answers a different question ("did the scheduler fire at all?").
	await pingExternalHeartbeat();
}

// ── External dead-man's switch (CUR-102) ─────────────────────────────────────────────────────────
// Every alert this app can raise is best-effort and posts through our own webhook from inside this
// cron — so if the cron stops or the webhook dies, the silence is indistinguishable from a healthy
// week. Alerting cannot detect its own death from the inside.
//
// This ping inverts the direction: Better Stack expects to HEAR from us, and alerts when it doesn't.
// This is the ONLY dead-man's switch: a healthy cron is silent, and Better Stack pages on the absence of the ping.
// The check-on-the-checker runs on infrastructure that is not ours, which is the only arrangement that
// survives us being down.
//
// PROD ONLY, on purpose. BETTERSTACK_HEARTBEAT_URL is set in production and deliberately NOT in
// preview: one heartbeat pinged by both environments would let preview hold it green while prod is
// dead — a check that cannot go red for the case it exists for. Preview needs its own heartbeat or
// none; it must not share this one.
async function pingExternalHeartbeat(): Promise<void> {
	const url = ((Reflect.get(config, "BETTERSTACK_HEARTBEAT_URL") as string | undefined) ?? "").trim();
	if (!url) return; // unset (preview, local, or before the secret sync) — not an error
	try {
		const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5000) });
		// fetch RESOLVES on 4xx/5xx. Checking status explicitly because the alternative is a heartbeat
		// leg that logs ok through a rotated/expired URL — the same failure that leaves a model leg green
		// through a WAF 403.
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		logger.info({ leg: "heartbeat-external", ok: true }, "[warm] leg");
	} catch (e) {
		// Swallowed: failing to reach Better Stack must never break the cron the rest of this file runs.
		// The consequence of a persistent failure is that BETTER STACK ALERTS US, which is the design.
		logger.warn(
			{ leg: "heartbeat-external", ok: false, err: e instanceof Error ? e.message : String(e) },
			"[warm] leg"
		);
	}
}
