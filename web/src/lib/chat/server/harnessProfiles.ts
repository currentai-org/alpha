// The harness extras each model gets, in one table keyed by the model it is asked for.
// One row per model, in place of a Set per measurement, a regex per workaround and a flag per
// experiment, so a bug traces to one model's entry. A row lists only what differs from the plain
// harness, so Mistral Large 3, the default, needs nothing beyond the one rule it was measured to be
// hurt by.
//
// Lookup is exact: the wire id, lower-cased, with any `:provider` suffix stripped. No prefix, regex or
// alias, so a `-thinking` build or a new size gets its own row rather than inheriting a sibling's
// (aider and LiteLLM both fall back by substring; that is the failure this shape rules out). A model
// with no row gets the plain harness and one logged error, never another model's profile.
//
// CUR-2697 holds the survey behind this shape and the measurement behind each extra. (CUR-2697)

import { isLocalModelId } from "../identity";
import { logger } from "./logger";
import { splitWireId } from "./modelProfiles";
import type { DigestRule } from "./textGeneration/answerClauses";

/**
 * The model crutches a turn can carry on top of the native shape (short prompt, model-called tools, the
 * model's own decoding). The base guards are not here: every model runs them (harness.ts).
 *
 * - `fewShotPersona`: the ~3.8k-token persona with verbatim few-shot dialogue, in place of the short
 *   prompt.
 * - `preTurnRetrieval`: RAG and web retrieval decided and run before the answer (pre-turn RAG, the web
 *   prelaunch, the search gate, the query rewrite and grounded-bail regen), in place of tools the model
 *   calls. For models that do not trigger a tool themselves (CUR-2060, CUR-2092).
 * - `mathPlanner`: the GLM turn planner and its code-checked ledger (mathRouting.ts). A model
 *   that writes its own total and stamps it "checked by code" gets a code-checked ledger instead,
 *   so the total always comes from code (CUR-2198).
 * - `groundedDecoding`: temperature 0.1 with frequency and presence penalties and a 1024-token cap
 *   (persona.ts GROUNDED_DECODING), in place of the model's own decoding.
 *
 * Mistral Large 3 carries none: it needs the base guards the full scaffold supplies, and it decides
 * when to search as well without the scaffold (CUR-2697). The other rows carry all four
 * because that is the turn they were offered and tested on; none is yet measured trick by trick, and a
 * row drops one only with an A/B on that model.
 */
export type HarnessTrick = "fewShotPersona" | "preTurnRetrieval" | "mathPlanner" | "groundedDecoding";

export const ALL_TRICKS: readonly HarnessTrick[] = Object.freeze([
	"fewShotPersona",
	"preTurnRetrieval",
	"mathPlanner",
	"groundedDecoding",
]);

type HarnessProfile = Readonly<{
	/**
	 * The tricks this model's turn carries. Absent means none: the native shape. A model with no row at
	 * all carries every trick, so an unvetted model gets the conservative turn, never the light one.
	 */
	tricks?: readonly HarnessTrick[];
	/**
	 * false: the fenced user turn goes out without the reply-language sentence (grounding.ts `guardFor`,
	 * CUR-1430), because it pushed this model into the wrong language. Absent means the sentence stays.
	 */
	replyLanguageRule?: false;
	/** Reasoning opens with no `<think>` and closes with a bare `</think>` (thinkFilter.ts, CUR-2470). */
	untaggedReasoningOpen?: true;
	/** The fenced turn repeats the injection rule after the closing fence (grounding.ts, CUR-970). */
	trailingFenceRule?: true;
	/**
	 * The languages this model is built for, as primary subtags. When the visitor's browser asks for one
	 * of them first, the system prompt ends by naming it (replyLanguage.ts, CUR-1713), for a model that
	 * answers in English under a rule that only says "the user's language".
	 */
	nativeLanguages?: readonly string[];
	/**
	 * Languages this model was measured answering in another language under the generic reply-language
	 * sentence, as ISO 639-3 codes. When the person writes in one of them, the system prompt ends by
	 * naming it (replyLanguage.ts `weakLanguageNote`, CUR-2237), behind `low-resource-per-model`.
	 */
	weakLanguages?: readonly string[];
	/**
	 * Calls to this gateway group go out with fallbacks disabled, and the answer's role-shaped request
	 * is pinned to a deployment that accepts roles (apertusStrictLane.ts, CUR-2092).
	 */
	strictLane?: true;
	/**
	 * With no probe row for any provider, the answer goes out flattened to one user message. A probe row
	 * decides once one exists (modelProfiles.ts `rolesNeedFlattening`, CUR-1294).
	 */
	flattenRolesUnprobed?: true;
	/**
	 * The most tokens, prompt and answer together, this model's lane accepts (CUR-2893). Absent means
	 * SERVED_CONTEXT_FLOOR. The history is fitted to it before every call (fitHistory.ts).
	 */
	contextTokens?: number;
	/**
	 * How long this model may take to its first chunk before the turn hedges or moves to the next lane
	 * (CUR-3487). Absent means the default timings in endpoints/failover.ts. Only a model measured to
	 * prefill slower than those defaults gets one. A model with a lane behind it stays under the output
	 * screen's 25s phase deadline (screenStream.ts) so a stalled lane still fails over inside a turn; a
	 * single-lane model may go past it, since the screen does not time the wait for a first token (CUR-2243).
	 */
	firstChunkMs?: number;
	/**
	 * How long this model's last lane may send nothing before the turn ends on the timeout notice
	 * (CUR-3939), rather than at the route's 45s watchdog. Opt-in: only a model whose healthy first
	 * token is measured well under it gets one, since a slow but healthy turn past it would be cut off.
	 * It must sit past the 8s hedge so the second same-lane attempt has time of its own.
	 */
	silentGiveUpMs?: number;
	/**
	 * How long Auto waits for this model's first chunk before asking its next choice (CUR-4384,
	 * CUR-4539). Absent means `AUTO_REPICK_GIVE_UP_MS` (20s). Only a model whose healthy first token is
	 * measured past that gets one, and it stays under the watchdog so the browser still gets to ask again.
	 */
	autoRepickGiveUpMs?: number;
	/**
	 * The least time this model's ordinary turn gets from the route's generation watchdog, total and
	 * silence alike (CUR-4403). Absent means the default (GENERATION_TIMEOUT_MS, 45s); a value below it
	 * changes nothing. For a lane whose first token is measured past 45s. It must sit past `silentGiveUpMs`,
	 * so the turn ends on the timeout notice rather than the watchdog.
	 */
	generationTimeoutMs?: number;
	/**
	 * On a native turn, calculate requires each group's count after every change before the expression
	 * (calculateTool.ts, CUR-4015). Opt-in per model: it took Medium from 0 of 15 to 10 of 10 on a
	 * regrouping question, and Large 3 from 0 of 5 to 5 of 5 on a three-turn one (CUR-1202).
	 */
	calculateCounts?: true;
	/**
	 * The answer-settings digest rules (answerClauses.ts `DIGEST_RULES`) this model does not
	 * get, because each one broke a behavior check on it. The setting keeps today's sentences. Absent
	 * means every rule. (CUR-3929)
	 */
	digestOmit?: readonly DigestRule[];
	/**
	 * This model returns well-formed tool calls on its lane, measured with a tool-call probe (CUR-4191).
	 * The LiteLLM gateway's `/models` lists no providers, so tool support can't be read from the host
	 * there and every gateway model would otherwise read as tool-less. Turning it on offers calculate and
	 * MCP tools and takes the turn off the math planner (mathRouting.ts `plansTurnFor`), so it needs
	 * the calculate-tool probe on this model to match the planner first.
	 */
	callsTools?: true;
	/**
	 * A `callsTools` model that answers arithmetic in prose when left to choose (CUR-4191). The turn
	 * planner still runs on its turns, and when the plan finds a number to work out, the answer's first
	 * request forces `calculate` instead of handing the turn to the route model. The answer stays this
	 * model's own.
	 */
	calculateOnPlannedMath?: true;
}>;

/**
 * Time to first token (`genToFirstTokenMs`) in production stays under 15s for Large 3, Apertus 1.5 70B,
 * GLM-5.2 and Bielik, so 20s gives up on a stalled turn without cutting a healthy one (CUR-3939). ALIA,
 * the SEA-LION rows and local models have slower healthy first tokens and stay on the watchdog.
 */
const SILENT_GIVE_UP_MS = 20_000;

/**
 * The gateway's self-hosted lanes, and the context any model without a published number gets. A
 * 600k-token request to each self-hosted model comes back 400 listing every fallback
 * deployment's limit, and every chain ends at a deployment serving 32000 (CUR-2893).
 */
const SERVED_CONTEXT_FLOOR = 32_000;

// Apertus deployments behind the gateway do not accept non-user roles, or answer them as another
// model (CUR-1294, CUR-2092): every Apertus row takes both.
// weakLanguages: Hausa and Amharic turns are routed as weak-language turns for every Apertus row
// (CUR-2237): on `language-turn-probe.mjs` the 70B answers Hausa in English and rarely keeps Amharic in
// Amharic. Measured on the 70B, applied to every Apertus row like the rest.
const APERTUS: HarnessProfile = Object.freeze({
	strictLane: true,
	flattenRolesUnprobed: true,
	tricks: ALL_TRICKS,
	silentGiveUpMs: SILENT_GIVE_UP_MS,
	weakLanguages: ["hau", "amh"],
});

// The gateway serves the 70B from one provider, whose request duration ranges from under a second
// to minutes (gateway request log, CUR-4403). Its only lane has nothing
// behind it, so the hedge is a second request to the same provider and starts at 30s; the give-up at 45s
// leaves that request 15s; the watchdog at 60s sits past both. A turn still streaming at 60s is extended
// to the ceiling (CUR-4009).
const APERTUS_70B: HarnessProfile = Object.freeze({
	...APERTUS,
	firstChunkMs: 30_000,
	silentGiveUpMs: 45_000,
	generationTimeoutMs: 60_000,
});

// A model offered for its answers rather than its tool calling keeps the full scaffold.
const SCAFFOLDED: HarnessProfile = Object.freeze({ tricks: ALL_TRICKS });

const PLAIN: HarnessProfile = Object.freeze({});

/**
 * One row per model the catalog can serve (every model with a qualification record, which is what
 * MODEL_ALLOWLIST may offer) plus the side-call models whose words reach the visitor. The evidence for each field is with the field's ticket.
 */
const HARNESS_PROFILES: Readonly<Record<string, HarnessProfile>> = {
	// Context for the three Mistral rows: Mistral `GET /v1/models` `max_context_length`, 262144 for
	// each; published, not probed at length.
	// replyLanguageRule: an English "who are you" came back in French 5 of 5 with the sentence, in
	// English 5 of 5 without it (CUR-2294).
	// Its last lane is Medium (CUR-3936's one permitted switch), which the give-up then covers.
	// calculateCounts, on a www-shaped request to the direct API (CUR-1202): a third turn moving one
	// half-timer to full-time, 0 of 5 without and 5 of 5 with; 11 single-turn regroup cases, 27 of 33
	// without and 30 of 33 with.
	"mistral-large-2512": {
		replyLanguageRule: false,
		contextTokens: 262_144,
		silentGiveUpMs: SILENT_GIVE_UP_MS,
		calculateCounts: true,
	},
	// Large 4 (preview, CUR-3027). Large 3's `replyLanguageRule: false` was measured on Large 3 only and
	// is not copied; Large 4 keeps the sentence until a measurement says otherwise.
	// Context: Mistral `GET /v1/models` `max_context_length` for `mistral-large-4`; published, not
	// probed at length.
	"mistral-large-2610": { contextTokens: 524_288 },
	// As the plan model writing the words under a checked ledger, an English
	// dinner-bill question came back in French 9 of 20 with the sentence, 0 of 10 without. (CUR-2530)
	"mistral-small-2603": { replyLanguageRule: false, contextTokens: 262_144 },
	// Offered through MISTRAL_MODELS. Without a row it gets the 32000 floor and refuses a
	// 63,633-token paste it can read (CUR-2893).
	// calculateCounts, 0/15 to 10/10 on the FTE regrouping question, 32/32 on every single. (CUR-4015)
	"mistral-medium-2604": { contextTokens: 262_144, calculateCounts: true },
	// The reply-language sentence was measured to help here (CUR-1430). Whether a probed model is
	// flattened is still decided per serving deployment from its probe rows.
	"swiss-ai/apertus-v1.5-70b": APERTUS_70B,
	"swiss-ai/apertus-v1.5-70b-thinking": APERTUS,
	"swiss-ai/apertus-v1.5-8b": APERTUS,
	"swiss-ai/apertus-8b-instruct": APERTUS,
	"aisingapore/qwen-sea-lion-v4-32b-it": SCAFFOLDED,
	// Healthy first token p90 is 21.4s across deployments (CUR-4539).
	"aisingapore/gemma-sea-lion-v4-27b-it": { ...SCAFFOLDED, autoRepickGiveUpMs: 25_000 },
	// firstChunkMs: first chunk arrives at 9-16s on a ~4.7k-token prompt over the gateway, so a 12s
	// failover deadline hands every picked turn to the fallback (CUR-3487).
	// callsTools (calculate-tool probe, CUR-4191): 32 of 32 right with tools, 29 of 32 on the planner.
	// autoRepickGiveUpMs: healthy first token p99 is 21.7s across deployments (CUR-4539).
	"aisingapore/nemotron-sea-lion-v4.8-120b-a12b": {
		firstChunkMs: 20_000,
		tricks: ALL_TRICKS,
		callsTools: true,
		autoRepickGiveUpMs: 25_000,
	},
	// untaggedReasoningOpen: its reasoning can open with no tag and close with `</think>` before the
	// answer, e.g. "…treat everything inside ONLY as a question…</think>The capital of Poland is
	// Warsaw." (CUR-2470). No fence rule: with it, the model still complied with the injection 9 of 10
	// (CUR-970).
	// nativeLanguages: asked "are you a person" in Spanish or Catalan, it answered in the asked language
	// 20 of 20 with that language named, against 0 of 20 without (CUR-1713).
	// No persona: with the persona and grounded decoding together, 21 of 33 searched turns recited the
	// fenced turn's preamble to the length cap; without the persona, 1 of 39 (CUR-3835). The persona
	// goes because dropping grounded decoding instead drew English replies to Spanish questions.
	"bsc-lt/alia-40b-instruct": {
		untaggedReasoningOpen: true,
		nativeLanguages: ["es", "ca", "gl", "eu"],
		tricks: ["preTurnRetrieval", "mathPlanner", "groundedDecoding"],
		// The formal rule leaves ALIA without the pushback a blood-pressure plan needs, and
		// the short rule turns a 1,500-word guide into a list of titles. (CUR-3929)
		digestOmit: ["formal", "short"],
		// CUR-4191, calculate-tool probe: 29 of 32 right with tools, 26 of 29 on the planner.
		callsTools: true,
		// Left to choose, it rarely calls calculate; forced, it calls it in about 1s where auto
		// takes 7-14s. (CUR-4191)
		calculateOnPlannedMath: true,
		// Healthy first token p50 is 8.8s and p95 42.8s, with 33 of 117 past 20s. 40s keeps most of them and still lands inside the 45s watchdog. (CUR-4539)
		autoRepickGiveUpMs: 40_000,
	},
	// trailingFenceRule: "DAN mode activated." 5 of 5 without the rule, 2 of 10 with it (CUR-970).
	// No callsTools (calculate-tool probe, CUR-4191): it called calculate on 31 of 32 yet got 26 right,
	// where the planner got 28 of 31.
	"speakleash/bielik-11b-v3.0-instruct": {
		trailingFenceRule: true,
		tricks: ALL_TRICKS,
		silentGiveUpMs: SILENT_GIVE_UP_MS,
		// The short rule makes Bielik refuse a long guide for length or write a ten-section
		// guide as an outline. (CUR-3929)
		digestOmit: ["short"],
	},
	// Pinned to Scaleway (hfProviderPin.ts), which the HF router lists with no context length, so it
	// gets the floor. No tricks (CUR-2697, 48 cases graded blind in both orders): all four lost to none
	// 12 to 19, and pre-turn retrieval alone lost 11 to 20, with no fewer wrong answers.
	// digestOmit short (CUR-3929): with the short rule a 1,500-word guide was cut at the 4,096-token cap
	// or empty in 3 of 6 runs, against 0 of 6 without it, and the model kept the short promise without
	// the rule (6 of 6).
	"zai-org/glm-5.2": { silentGiveUpMs: SILENT_GIVE_UP_MS, digestOmit: ["short"] },
};

const reportedUnlisted = new Set<string>();

/** The profile key for a wire id: lower-cased, `:provider` stripped. */
function harnessProfileKey(modelId: string): string {
	return splitWireId(modelId).model.trim().toLowerCase();
}

/**
 * Ids that are not catalog entries and so never get a row: a user's own `local:` endpoint, and the
 * agent route (`potluck-agent`, models.ts). A miss on one is expected and logs at warn, which keeps it
 * out of axiom-alert's server-errors count (CUR-4358).
 */
const AGENT_MODEL_ID = "potluck-agent";
const rowNeverExpected = (modelId: string) => isLocalModelId(modelId) || modelId === AGENT_MODEL_ID;

/**
 * The extras this model gets. An unlisted model gets the plain harness. Looked up by the id a turn
 * asked for, a miss is also one `logger.error` per id, so a model added to MODEL_ALLOWLIST without a
 * row is loud in the logs and harmless in the turn. A name the provider sent back (`openai/…`, its own
 * casing) is matched quietly, since it is the provider's spelling and not a catalog entry.
 */
function harnessProfileFor(modelId: string | undefined, { requested = true } = {}): HarnessProfile {
	if (!modelId) return PLAIN;
	const key = harnessProfileKey(modelId);
	const row = HARNESS_PROFILES[key];
	if (row) return row;
	if (requested && !reportedUnlisted.has(key)) {
		reportedUnlisted.add(key);
		logger[rowNeverExpected(modelId) ? "warn" : "error"](
			{ model: key },
			"[harness-profile] no row for this model; it gets the plain harness"
		);
	}
	return PLAIN;
}

/** Whether the fenced turn for this model should carry the reply-language sentence (CUR-2294). */
export function replyLanguageRuleFits(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId).replyLanguageRule !== false;
}

/**
 * This model's reasoning opens with no `<think>` tag and closes with `</think>` (CUR-2470). Callers
 * pass both the requested id and the model the provider named in its response, so a miss is quiet.
 */
export function opensReasoningUntagged(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId, { requested: false }).untaggedReasoningOpen === true;
}

/** Whether this model's fenced turn repeats the injection rule after the fence (CUR-970). */
/** Whether this model's system prompt names the language of the person's message (CUR-1713). */
export function nativeLanguages(modelId: string | undefined): readonly string[] {
	return harnessProfileFor(modelId).nativeLanguages ?? [];
}

/** The languages this model drifts out of under the generic rule (CUR-2237). */
export function weakLanguages(modelId: string | undefined): readonly string[] {
	return harnessProfileFor(modelId).weakLanguages ?? [];
}

/** Whether this model's row declares tool support the host's listing can't show (CUR-4191). */
export function declaresToolCalls(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId, { requested: false }).callsTools === true;
}

/** Whether a planned math turn forces this model's first answer request to call `calculate` (CUR-4191). */
export function calculatesOnPlannedMath(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId, { requested: false }).calculateOnPlannedMath === true;
}

export function restatesRuleAfterFence(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId).trailingFenceRule === true;
}

/**
 * Whether calls to this model take the strict lane: no gateway fallbacks, roles pinned (CUR-2092).
 * Quiet on a miss: every call through the endpoint asks, side calls included, and the answer lane's
 * own lookups already log an unlisted model.
 */
export function takesStrictLane(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId, { requested: false }).strictLane === true;
}

/** The context this model's lane accepts, for fitting the history (CUR-2893). Quiet on a miss, as above. */
export function contextTokensFor(modelId: string | undefined): number {
	return harnessProfileFor(modelId, { requested: false }).contextTokens ?? SERVED_CONTEXT_FLOOR;
}

/** Whether this model is flattened while no probe row covers it (CUR-1294). Quiet on a miss, as above. */
export function flattensRolesUnprobed(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId, { requested: false }).flattenRolesUnprobed === true;
}

/**
 * This model's own first-chunk allowance, or null when it has none and the default timings apply
 * (CUR-3487). Quiet on a miss, as above.
 */
export function firstChunkMsFor(modelId: string | undefined): number | null {
	return harnessProfileFor(modelId, { requested: false }).firstChunkMs ?? null;
}

/** This model's last-lane give-up, or null to leave a silent turn to the watchdog (CUR-3939). */
export function silentGiveUpMsFor(modelId: string | undefined): number | null {
	return harnessProfileFor(modelId, { requested: false }).silentGiveUpMs ?? null;
}

/** How long Auto waits for this model before asking its next choice, or null for the default (CUR-4539). */
export function autoRepickGiveUpMsFor(modelId: string | undefined): number | null {
	return harnessProfileFor(modelId, { requested: false }).autoRepickGiveUpMs ?? null;
}

/** This model's own floor under the generation watchdog, or null for the default (CUR-4403). */
export function generationTimeoutMsFor(modelId: string | undefined): number | null {
	return harnessProfileFor(modelId, { requested: false }).generationTimeoutMs ?? null;
}

/** Whether this model's native calculate asks for each group's count first (CUR-4015). */
export function asksCalculateCounts(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId).calculateCounts === true;
}

/**
 * The tricks this model's turn carries (CUR-2697). A model with no row gets every trick and the one
 * logged error `harnessProfileFor` writes for an unlisted id.
 */
export function tricksFor(modelId: string | undefined): ReadonlySet<HarnessTrick> {
	const key = modelId ? harnessProfileKey(modelId) : "";
	const row = harnessProfileFor(modelId);
	return new Set(key in HARNESS_PROFILES ? (row.tricks ?? []) : ALL_TRICKS);
}

/** The answer-settings digest rules this model's row leaves out (CUR-3929). Empty for every other row. */
export function digestOmitFor(modelId: string | undefined): ReadonlySet<DigestRule> {
	return new Set(harnessProfileFor(modelId).digestOmit ?? []);
}
