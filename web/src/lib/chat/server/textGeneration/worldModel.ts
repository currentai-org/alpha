import { generateFromDefaultEndpoint } from "$lib/chat/server/generateFromDefaultEndpoint";
import { getReturnFromGenerator } from "$lib/chat/utils/getReturnFromGenerator";
import { logger } from "$lib/chat/server/logger";
import { config } from "$lib/chat/server/config";

/**
 * WORLD-MODEL PRE-PASS (heuristic-override mitigation).
 *
 * The served 8B fails a class of "implicit world-model" turns where a surface cue
 * (a short distance) overrides a physical constraint — the canonical case being
 * *"the car wash is 100m away, should I walk or drive?"* (gold: drive — the car
 * is the thing being washed, so it must be present). On the natural eval set the
 * bare model gets 3/30 of these traps; this pre-pass lifts it to 26/30 with no
 * false flips on the walk-control turns.
 *
 * Architecture (proven in evals/pragmatics, condition F_reframe2):
 *   SEPARATE the EXTRACT from the JUDGE. The 8B is a competent fact-EXTRACTOR but
 *   a poor direct-JUDGE of this class, so we ask it two NEUTRAL yes/no facts and
 *   let a DETERMINISTIC gate (not the model) decide. The deterministic gate is
 *   what removes the model's judgment — and its false-flips — from the path:
 *   holding the same facts, a model-judge scored 56/65, the gate 61/65.
 *
 * When the gate fires, we INJECT a neutral world-state note into the system
 * prompt (the same mechanism as search grounding / MCP results). The 8B reliably
 * DEFERS to injected facts, so it then phrases the correct answer.
 *
 * GATE, not removal. Default OFF: an unset/typo'd `WORLD_MODEL_PREPASS` resolves
 * to false (no extra call, no behaviour change). Read via Reflect.get because the
 * key isn't in the committed .env — same pattern as MULTIMODAL_ENABLED.
 */
export const WORLD_MODEL_PREPASS =
	String(Reflect.get(config, "WORLD_MODEL_PREPASS") ?? "")
		.trim()
		.toLowerCase() === "true";

// A turn longer than this is not a short walk-or-drive style errand decision; skip
// the pre-pass to bound per-turn latency. Domain-neutral length bound, not a
// topic filter.
const MAX_TURN_CHARS = 600;

// ── Distance occlusion ──────────────────────────────────────────────────────
// The distance cue ("100m away") is the heuristic hook that pulls the extraction
// toward "just walk". Strip it before extracting so the model reasons about the
// PURPOSE, not the proximity. Ported verbatim from evals/pragmatics/pragmatics.py
// (occlude_distance). Exported for unit testing.
const DIST_RE =
	/\b(only |just )?\d+(\.\d+)?\s?(m|km|meters?|metres?|kilom\w*)\b( away| down the road| from (my|the) (house|home))?/gi;

export function occludeDistance(text: string): string {
	return text.replace(DIST_RE, "nearby");
}

// ── The two neutral facts (condition F_reframe2) ────────────────────────────
// The two — and only two — reasons a road vehicle is actually required: the trip
// SERVICES a road vehicle (so the vehicle must be present), OR it moves a load too
// heavy/bulky to carry on foot. Asking these directly avoids the ambiguous
// "central thing" hinge, which misfires on fuel/self-service.
// VERBATIM from the validated harness (evals/pragmatics REFRAME2_SYS). Do NOT
// embellish: an appended injection-guard paragraph FLIPS
// the car-wash extraction (services_a_vehicle yes→no) on the 8B — the extra text
// distracts a weak model. Prompt parity with the validated condition beats a
// nice-to-have guard here; the extraction only yields two booleans feeding a
// deterministic gate, so a prompt-injection can at most flip walk/drive advice.
// Exported so a probe can call the EXACT extraction prompt rather than a copy of it —
// evals/warmth-rubrics.ts exists because one such copy silently drifted.
export const REFRAME_SYS =
	"You extract two neutral yes/no facts about a situation as JSON. You do NOT " +
	"give travel advice and you do NOT decide walk vs drive. Answer only the JSON.";

export const REFRAME_USER = (situation: string) =>
	`Situation: ${situation}

Answer as JSON with exactly these two keys:
- "services_a_vehicle": does the purpose involve servicing, washing, cleaning, fuelling, charging, repairing, inspecting, or otherwise acting ON a road vehicle (car, van, motorbike) — so that the vehicle itself must be physically at the destination? "yes" or "no"
- "moves_heavy_load": to accomplish this, must the person transport an object too heavy or bulky to carry by hand on foot — either bringing it to the destination or taking it home? A person or animal that walks on its own is NOT a load. "yes" or "no"

Return only the JSON object.`;

export type Reframe2Facts = {
	services_a_vehicle?: string;
	moves_heavy_load?: string;
};

/**
 * Parse the model's JSON-ish output into the two facts. Grabs the first {...}
 * block and tolerates trailing commas / single quotes (mirrors the harness
 * `_parse_json`). Returns null when nothing parses — the caller fails open (no
 * note), so a malformed extraction never injects a spurious constraint.
 */
export function parseReframe2(raw: string | undefined): Reframe2Facts | null {
	const m = (raw ?? "").match(/\{[\s\S]*\}/);
	if (!m) return null;
	const tryParse = (s: string): Reframe2Facts | null => {
		try {
			const o = JSON.parse(s);
			return o && typeof o === "object" ? (o as Reframe2Facts) : null;
		} catch {
			return null;
		}
	};
	return tryParse(m[0]) ?? tryParse(m[0].replace(/,\s*}/g, "}").replace(/'/g, '"'));
}

const isYes = (v: string | undefined): boolean =>
	String(v ?? "")
		.trim()
		.toLowerCase()
		.startsWith("y");

/**
 * The deterministic gate (NOT the model): a road vehicle is required iff the trip
 * services a vehicle OR moves a heavy load. Exported for unit testing.
 */
export function reframe2Gate(facts: Reframe2Facts | null): boolean {
	if (!facts) return false;
	return isYes(facts.services_a_vehicle) || isYes(facts.moves_heavy_load);
}

// The note injected when the gate fires. The GATE has already DECIDED (the
// deterministic reframe2Gate over the model-extracted facts — 61/65 accurate);
// the model's only job is to PHRASE that decision, not re-open it. A softer
// note ("take this into account") lets the 8B re-litigate back to "walk" —
// the override failure this pre-pass exists to stop. So the note states the decision directively.
// It is only ever injected when requires_vehicle is true, so "drive" is always
// the correct conclusion here.
export const WORLD_MODEL_NOTE =
	"Decision already determined for this turn — apply it, do not re-derive it: " +
	"this errand requires a road vehicle to be physically present at the " +
	"destination (the vehicle itself is what's being serviced/fuelled/repaired, " +
	"or a load too heavy to carry on foot must be moved). Walking would leave " +
	"behind the very thing the errand needs, so the answer is to DRIVE / take the " +
	"vehicle. Lead with that recommendation and explain it naturally in your own " +
	"voice. Do not hedge toward walking and do not mention or restate this note.";

/** Append the world-model note to the system prompt (same shape as grounding). */
export function injectWorldModelNote(preprompt: string | undefined, note: string): string {
	const base = preprompt?.trim();
	return base ? `${base}\n\n${note}` : note;
}

/**
 * Run the world-model pre-pass on the last user turn. Returns a note to inject
 * when the deterministic gate fires, else null. Best-effort: returns null on any
 * error, when disabled, or for empty/overlong turns — never throws, never blocks
 * the turn (mirrors classifySearchNeed).
 */
export async function maybeWorldModelNote(
	lastUserText: string | undefined,
	locals: App.Locals | undefined
): Promise<string | null> {
	if (!WORLD_MODEL_PREPASS) return null;
	const q = (lastUserText ?? "").trim();
	if (q.length < 3 || q.length > MAX_TURN_CHARS) return null;
	try {
		const raw = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content: REFRAME_USER(occludeDistance(q)) }],
				preprompt: REFRAME_SYS,
				// Clean GREEDY decoding, matching the validated harness call exactly.
				// endpointOai merges { ...model.parameters, ...generateSettings }, so we
				// must explicitly null the chat model's anti-repetition penalties / top_p
				// here — otherwise they perturb the extraction and flip facts (the car wash
				// extracts services_a_vehicle:"no" under the chat defaults,
				// "yes" under clean greedy). Extraction must be deterministic, not chatty.
				generateSettings: {
					max_tokens: 120,
					temperature: 0,
					top_p: 1,
					frequency_penalty: 0,
					presence_penalty: 0,
				},
				locals,
			})
		);
		return reframe2Gate(parseReframe2(String(raw ?? ""))) ? WORLD_MODEL_NOTE : null;
	} catch (e) {
		logger.error(e, "world-model pre-pass failed");
		return null;
	}
}
