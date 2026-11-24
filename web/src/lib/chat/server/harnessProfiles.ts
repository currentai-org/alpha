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
// holds the survey behind this shape and the measurement behind each extra.

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
 *   calls. For models that do not trigger a tool themselves.
 * - `mathPlanner`: the GLM turn planner and its code-checked ledger (mathRouting.ts). A model
 *   that writes its own total and stamps it "checked by code" gets a code-checked ledger instead,
 *   so the total always comes from code.
 * - `groundedDecoding`: temperature 0.1 with frequency and presence penalties and a 1024-token cap
 *   (persona.ts GROUNDED_DECODING), in place of the model's own decoding.
 *
 * Mistral Large 3 carries none: it needs the base guards the full scaffold supplies, and it decides
 * when to search as well without the scaffold. The other rows carry all four
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
	 *), because it pushed this model into the wrong language. Absent means the sentence stays.
	 */
	replyLanguageRule?: false;
	/** Reasoning opens with no `<think>` and closes with a bare `</think>` (thinkFilter.ts). */
	untaggedReasoningOpen?: true;
	/** The fenced turn repeats the injection rule after the closing fence (grounding.ts). */
	trailingFenceRule?: true;
	/**
	 * The fenced user turn carries the short guard (grounding.ts `compactGuardFor`) in place of the
	 * ~5.5k-char guard and per-turn notes. Kept for a small CPU model that repeats the question back when
	 * the bare question sits after that much text. The random fence stays either way.
	 */
	compactFence?: true;
	/**
	 * The languages this model is built for, as primary subtags. When the visitor's browser asks for one
	 * of them first, the system prompt ends by naming it (replyLanguage.ts), for a model that
	 * answers in English under a rule that only says "the user's language".
	 */
	nativeLanguages?: readonly string[];
	/**
	 * Languages this model was measured answering in another language under the generic reply-language
	 * sentence, as ISO 639-3 codes. When the person writes in one of them, the system prompt ends by
	 * naming it (replyLanguage.ts `weakLanguageNote`), behind `low-resource-per-model`.
	 */
	weakLanguages?: readonly string[];
	/**
	 * true: when the latest message reads as a different language from the answer before it, the fenced
	 * turn names the message's language after the fence (replyLanguage.ts `switchedLanguageNote`,
	 *), for a model measured answering a switched turn in the conversation's earlier language.
	 */
	namesSwitchedLanguage?: true;
	/**
	 * Calls to this gateway group go out with fallbacks disabled, and the answer's role-shaped request
	 * is pinned to a deployment that accepts roles (apertusStrictLane.ts).
	 */
	strictLane?: true;
	/**
	 * With no probe row for any provider, the answer goes out flattened to one user message. A probe row
	 * decides once one exists (modelProfiles.ts `rolesNeedFlattening`).
	 */
	flattenRolesUnprobed?: true;
	/**
	 * The most tokens, prompt and answer together, this model's lane accepts. Absent means
	 * SERVED_CONTEXT_FLOOR. The history is fitted to it before every call (fitHistory.ts).
	 */
	contextTokens?: number;
	/**
	 * Tokens this model spends reasoning before it answers, added to the answer reserve to make its output
	 * cap (generate.ts `answerCapFor`). Absent means none: the cap is the reserve alone. The cap
	 * is also what fitHistory keeps free, so on a lane near SERVED_CONTEXT_FLOOR every token here comes out
	 * of the history; give one only where `contextTokens` leaves room for it.
	 */
	reasoningTokens?: number;
	/**
	 * How long this model may take to its first chunk before the turn hedges or moves to the next lane.
	 * Absent means the default timings in endpoints/failover.ts. Only a model measured to
	 * prefill slower than those defaults gets one. A model with a lane behind it stays under the output
	 * screen's 25s phase deadline (screenStream.ts) so a stalled lane still fails over inside a turn; a
	 * single-lane model may go past it, since the screen does not time the wait for a first token.
	 */
	firstChunkMs?: number;
	/**
	 * How long this model's last lane may send nothing before the turn ends on the timeout notice,
	 * rather than at the route's 45s watchdog. Opt-in: only a model whose healthy first
	 * token is measured well under it gets one, since a slow but healthy turn past it would be cut off.
	 * It must sit past the 8s hedge so the second same-lane attempt has time of its own.
	 */
	silentGiveUpMs?: number;
	/**
	 * How long Auto waits for this model's first chunk before asking its next choice (
	 *). Absent means `AUTO_REPICK_GIVE_UP_MS` (20s). Only a model whose healthy first token is
	 * measured past that gets one, and it stays under the watchdog so the browser still gets to ask again.
	 */
	autoRepickGiveUpMs?: number;
	/**
	 * The least time this model's ordinary turn gets from the route's generation watchdog, total and
	 * silence alike. Absent means the default (GENERATION_TIMEOUT_MS, 45s); a value below it
	 * changes nothing. For a lane whose first token is measured past 45s. It must sit past `silentGiveUpMs`,
	 * so the turn ends on the timeout notice rather than the watchdog.
	 */
	generationTimeoutMs?: number;
	/**
	 * On a native turn, calculate requires each group's count after every change before the expression
	 * (calculateTool.ts). Opt-in per model: it took Medium from 0 of 15 to 10 of 10 on a
	 * regrouping question, and Large 3 from 0 of 5 to 5 of 5 on a three-turn one.
	 */
	calculateCounts?: true;
	/**
	 * The answer-settings digest rules (answerClauses.ts `DIGEST_RULES`) this model does not
	 * get, because each one broke a behavior check on it. The setting keeps today's sentences. Absent
	 * means every rule.
	 */
	digestOmit?: readonly DigestRule[];
	/**
	 * This model returns well-formed tool calls on its lane, measured with a tool-call probe.
	 * The LiteLLM gateway's `/models` lists no providers, so tool support can't be read from the host
	 * there and every gateway model would otherwise read as tool-less. Turning it on offers calculate and
	 * MCP tools and takes the turn off the math planner (mathRouting.ts `plansTurnFor`), so it needs
	 * the calculate-tool probe on this model to match the planner first.
	 */
	callsTools?: true;
	/**
	 * A `callsTools` model that answers arithmetic in prose when left to choose. The turn
	 * planner still runs on its turns, and when the plan finds a number to work out, the answer's first
	 * request forces `calculate` instead of handing the turn to the route model. The answer stays this
	 * model's own.
	 */
	calculateOnPlannedMath?: true;
}>;

/**
 * Time to first token (`genToFirstTokenMs`) in production stays under 15s for Large 3, Apertus 1.5 70B,
 * GLM-5.2 and Bielik, so 20s gives up on a stalled turn without cutting a healthy one. ALIA,
 * the SEA-LION rows and local models have slower healthy first tokens and stay on the watchdog.
 */
const SILENT_GIVE_UP_MS = 20_000;

/**
 * The gateway's self-hosted lanes, and the context any model without a published number gets. A
 * 600k-token request to each self-hosted model comes back 400 listing every fallback
 * deployment's limit, and every chain ends at a deployment serving 32000.
 */
const SERVED_CONTEXT_FLOOR = 32_000;

// Apertus deployments behind the gateway do not accept non-user roles, or answer them as another
// model: every Apertus row takes both.
// weakLanguages: Hausa and Amharic turns are routed as weak-language turns for every Apertus row:
// on `language-turn-probe.mjs` the 70B answers Hausa in English and rarely keeps Amharic in
// Amharic. Measured on the 70B, applied to every Apertus row like the rest.
// namesSwitchedLanguage: after two turns in one language, the 70B answered "Now in English please" in
// the earlier language in 4 of 26 launch languages on www; Mistral Large passed 16 of 16.
const APERTUS: HarnessProfile = Object.freeze({
	strictLane: true,
	flattenRolesUnprobed: true,
	tricks: ALL_TRICKS,
	silentGiveUpMs: SILENT_GIVE_UP_MS,
	weakLanguages: ["hau", "amh"],
	namesSwitchedLanguage: true,
});

// The gateway serves the 70B from one provider, whose request duration ranges from under a second
// to minutes (gateway request log). Its only lane has nothing
// behind it, so the hedge is a second request to the same provider and starts at 30s; the give-up at 45s
// leaves that request 15s; the watchdog at 60s sits past both. A turn still streaming at 60s is extended
// to the ceiling.
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
	// English 5 of 5 without it.
	// Its last lane is Medium (the one permitted switch), which the give-up then covers.
	// calculateCounts, on a www-shaped request to the direct API: a third turn moving one
	// half-timer to full-time, 0 of 5 without and 5 of 5 with; 11 single-turn regroup cases, 27 of 33
	// without and 30 of 33 with.
	"mistral-large-2512": {
		replyLanguageRule: false,
		contextTokens: 262_144,
		silentGiveUpMs: SILENT_GIVE_UP_MS,
		calculateCounts: true,
	},
	// Large 4 (preview). Large 3's `replyLanguageRule: false` was measured on Large 3 only and
	// is not copied; Large 4 keeps the sentence until a measurement says otherwise.
	// Context: Mistral `GET /v1/models` `max_context_length` for `mistral-large-4`; published, not
	// probed at length.
	// reasoningTokens,: reasoning and answer shared the 4,096 cap, and 1 of 25 production
	// finishes in three days ended on `length` at the cap (17,963 characters). 12,288 brings the cap to 16,384,
	// the conversation-API eval ceiling: a bound until `reasoningChars` on `[generation] finish` gives a
	// p99, since the cap censors every longer run. It costs the history 3% of this context.
	"mistral-large-2610": { contextTokens: 524_288, reasoningTokens: 12_288 },
	// as the plan model writing the words under a checked ledger, an English
	// dinner-bill question came back in French 9 of 20 with the sentence, 0 of 10 without.
	"mistral-small-2603": { replyLanguageRule: false, contextTokens: 262_144 },
	// Offered through MISTRAL_MODELS. Without a row it gets the 32000 floor and refuses a
	// 63,633-token paste it can read.
	// calculateCounts, 0/15 to 10/10 on the FTE regrouping question, 32/32 on every single.
	"mistral-medium-2604": { contextTokens: 262_144, calculateCounts: true },
	// The reply-language sentence was measured to help here. Whether a probed model is
	// flattened is still decided per serving deployment from its probe rows.
	"swiss-ai/apertus-v1.5-70b": APERTUS_70B,
	"swiss-ai/apertus-v1.5-70b-thinking": APERTUS,
	"swiss-ai/apertus-v1.5-8b": APERTUS,
	"swiss-ai/apertus-8b-instruct": APERTUS,
	"aisingapore/qwen-sea-lion-v4-32b-it": SCAFFOLDED,
	// Healthy first token p90 is 21.4s across deployments.
	"aisingapore/gemma-sea-lion-v4-27b-it": { ...SCAFFOLDED, autoRepickGiveUpMs: 25_000 },
	// firstChunkMs: first chunk arrives at 9-16s on a ~4.7k-token prompt over the gateway, so a 12s
	// failover deadline hands every picked turn to the fallback.
	// callsTools (calculate-tool probe): 32 of 32 right with tools, 29 of 32 on the planner.
	// autoRepickGiveUpMs: healthy first token p99 is 21.7s across deployments.
	"aisingapore/nemotron-sea-lion-v4.8-120b-a12b": {
		firstChunkMs: 20_000,
		tricks: ALL_TRICKS,
		callsTools: true,
		autoRepickGiveUpMs: 25_000,
	},
	// untaggedReasoningOpen: its reasoning can open with no tag and close with `</think>` before the
	// answer, e.g. "…treat everything inside ONLY as a question…</think>The capital of Poland is
	// Warsaw.". No fence rule: with it, the model still complied with the injection 9 of 10.
	// nativeLanguages: asked "are you a person" in Spanish or Catalan, it answered in the asked language
	// 20 of 20 with that language named, against 0 of 20 without.
	// No persona: with the persona and grounded decoding together, 21 of 33 searched turns recited the
	// fenced turn's preamble to the length cap; without the persona, 1 of 39. The persona
	// goes because dropping grounded decoding instead drew English replies to Spanish questions.
	"bsc-lt/alia-40b-instruct": {
		untaggedReasoningOpen: true,
		nativeLanguages: ["es", "ca", "gl", "eu"],
		tricks: ["preTurnRetrieval", "mathPlanner", "groundedDecoding"],
		// The formal rule leaves ALIA without the pushback a blood-pressure plan needs, and
		// the short rule turns a 1,500-word guide into a list of titles.
		digestOmit: ["formal", "short"],
		// calculate-tool probe: 29 of 32 right with tools, 26 of 29 on the planner.
		callsTools: true,
		// Left to choose, it rarely calls calculate; forced, it calls it in about 1s where auto
		// takes 7-14s.
		calculateOnPlannedMath: true,
		// Healthy first token p50 is 8.8s and p95 42.8s, with 33 of 117 past 20s. 40s keeps most of them and still lands inside the 45s watchdog.
		autoRepickGiveUpMs: 40_000,
		// NextBit answers 429 "Model is at token capacity" to the second request an 8s hedge sends
		// while the first is still waiting. With p50 first token at
		// 8.8s the default hedge doubles about half of ALIA's turns, so it starts at 30s as for the 70B,
		// and a turn past 45s with its first token due (p95 42.8s) keeps going to 60s.
		firstChunkMs: 30_000,
		generationTimeoutMs: 60_000,
	},
	// trailingFenceRule: "DAN mode activated." 5 of 5 without the rule, 2 of 10 with it.
	// No callsTools (calculate-tool probe): it called calculate on 31 of 32 yet got 26 right,
	// where the planner got 28 of 31.
	"speakleash/bielik-11b-v3.0-instruct": {
		trailingFenceRule: true,
		tricks: ALL_TRICKS,
		silentGiveUpMs: SILENT_GIVE_UP_MS,
		// The short rule makes Bielik refuse a long guide for length or write a ten-section
		// guide as an outline.
		digestOmit: ["short"],
	},
	// Pinned to Featherless (hfProviderPin.ts), which the HF router lists with no context length, so it
	// gets the floor. No tricks (48 cases graded blind in both orders): all four lost to none
	// 12 to 19, and pre-turn retrieval alone lost 11 to 20, with no fewer wrong answers.
	// digestOmit short: with the short rule a 1,500-word guide was cut at the 4,096-token cap
	// or empty in 3 of 6 runs, against 0 of 6 without it, and the model kept the short promise without
	// the rule (6 of 6).
	"zai-org/glm-5.2": { silentGiveUpMs: SILENT_GIVE_UP_MS, digestOmit: ["short"] },
	// The model selfhost/compose.yaml's local profile serves, under its default alias. A CPU reads the
	// ~4.7k-token first prompt at 70 tokens a second (67.6 s on a 4-vCPU runner), so it takes the short
	// prompt in place of the persona. Pre-turn retrieval stays: llama.cpp lists no providers, so this
	// model reads as tool-less and a row that names no trick would get every trick back (harness.ts).
	// A different LOCAL_MODEL_ALIAS needs its own row.
	// compactFence and groundedDecoding: replaying one walk turn, the full guard answered 2 of 6
	// with a fresh fence; the short guard at llama's default temperature answered 8 of 10
	// with a fresh fence, and at temperature 0 under QUESTION_ + 4 digits, 10 of 10. The
	// misses repeated the question.
	"qwen2.5-0.5b-instruct": { tricks: ["preTurnRetrieval", "groundedDecoding"], compactFence: true },
};

const reportedUnlisted = new Set<string>();

/** The profile key for a wire id: lower-cased, `:provider` stripped. */
function harnessProfileKey(modelId: string): string {
	return splitWireId(modelId).model.trim().toLowerCase();
}

/**
 * Ids that are not catalog entries and so never get a row: a user's own `local:` endpoint, and the
 * agent route (`potluck-agent`, models.ts). A miss on one is expected and logs at warn, which keeps it
 * out of axiom-alert's server-errors count.
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

/** Whether the fenced turn for this model should carry the reply-language sentence. */
export function replyLanguageRuleFits(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId).replyLanguageRule !== false;
}

/**
 * This model's reasoning opens with no `<think>` tag and closes with `</think>`. Callers
 * pass both the requested id and the model the provider named in its response, so a miss is quiet.
 */
export function opensReasoningUntagged(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId, { requested: false }).untaggedReasoningOpen === true;
}

/** Whether this model's fenced turn repeats the injection rule after the fence. */
/** Whether this model's system prompt names the language of the person's message. */
export function nativeLanguages(modelId: string | undefined): readonly string[] {
	return harnessProfileFor(modelId).nativeLanguages ?? [];
}

/** Whether a switched-language turn names the message's language for this model. */
export function namesSwitchedLanguage(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId).namesSwitchedLanguage === true;
}

/** The languages this model drifts out of under the generic rule. */
export function weakLanguages(modelId: string | undefined): readonly string[] {
	return harnessProfileFor(modelId).weakLanguages ?? [];
}

/** Whether this model's row declares tool support the host's listing can't show. */
export function declaresToolCalls(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId, { requested: false }).callsTools === true;
}

/** Whether a planned math turn forces this model's first answer request to call `calculate`. */
export function calculatesOnPlannedMath(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId, { requested: false }).calculateOnPlannedMath === true;
}

export function restatesRuleAfterFence(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId).trailingFenceRule === true;
}

/** Whether this model's fenced turn takes the short guard (`compactFence`). */
export function takesCompactFence(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId).compactFence === true;
}

/**
 * Whether calls to this model take the strict lane: no gateway fallbacks, roles pinned.
 * Quiet on a miss: every call through the endpoint asks, side calls included, and the answer lane's
 * own lookups already log an unlisted model.
 */
export function takesStrictLane(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId, { requested: false }).strictLane === true;
}

/** The context this model's lane accepts, for fitting the history. Quiet on a miss, as above. */
export function contextTokensFor(modelId: string | undefined): number {
	return harnessProfileFor(modelId, { requested: false }).contextTokens ?? SERVED_CONTEXT_FLOOR;
}

/** Tokens this model reasons before answering, on top of the answer reserve. Quiet on a miss. */
export function reasoningTokensFor(modelId: string | undefined): number {
	return harnessProfileFor(modelId, { requested: false }).reasoningTokens ?? 0;
}

/** Whether this model is flattened while no probe row covers it. Quiet on a miss, as above. */
export function flattensRolesUnprobed(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId, { requested: false }).flattenRolesUnprobed === true;
}

/**
 * This model's own first-chunk allowance, or null when it has none and the default timings apply.
 * Quiet on a miss, as above.
 */
export function firstChunkMsFor(modelId: string | undefined): number | null {
	return harnessProfileFor(modelId, { requested: false }).firstChunkMs ?? null;
}

/** This model's last-lane give-up, or null to leave a silent turn to the watchdog. */
export function silentGiveUpMsFor(modelId: string | undefined): number | null {
	return harnessProfileFor(modelId, { requested: false }).silentGiveUpMs ?? null;
}

/** How long Auto waits for this model before asking its next choice, or null for the default. */
export function autoRepickGiveUpMsFor(modelId: string | undefined): number | null {
	return harnessProfileFor(modelId, { requested: false }).autoRepickGiveUpMs ?? null;
}

/** This model's own floor under the generation watchdog, or null for the default. */
export function generationTimeoutMsFor(modelId: string | undefined): number | null {
	return harnessProfileFor(modelId, { requested: false }).generationTimeoutMs ?? null;
}

/** Whether this model's native calculate asks for each group's count first. */
export function asksCalculateCounts(modelId: string | undefined): boolean {
	return harnessProfileFor(modelId).calculateCounts === true;
}

/**
 * The tricks this model's turn carries. A model with no row gets every trick and the one
 * logged error `harnessProfileFor` writes for an unlisted id.
 */
export function tricksFor(modelId: string | undefined): ReadonlySet<HarnessTrick> {
	const key = modelId ? harnessProfileKey(modelId) : "";
	const row = harnessProfileFor(modelId);
	return new Set(key in HARNESS_PROFILES ? (row.tricks ?? []) : ALL_TRICKS);
}

/** The answer-settings digest rules this model's row leaves out. Empty for every other row. */
export function digestOmitFor(modelId: string | undefined): ReadonlySet<DigestRule> {
	return new Set(harnessProfileFor(modelId).digestOmit ?? []);
}
