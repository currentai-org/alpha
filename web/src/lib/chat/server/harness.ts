// Which harness a turn runs under, decided once per turn and read by every seam.
//
// The scaffolded path serves models that do not reliably trigger a tool (CUR-2060, CUR-2092):
// retrieval, search and arithmetic are decided by side calls before the answer, the prompt carries
// ~3.8k tokens of steering. A model that calls tools well needs none of that. "native" is the other
// shape: a short system prompt, RAG, web search and calculate offered as tools the model calls itself,
// and its own decoding defaults. The base guards are the same under both (CUR-2697): CSAM scan, input
// and output screening, the injection fence, the identity and account lock, the honesty stream, and
// provenance.
//
// One fact decides it: the model's row in harnessProfiles.ts names the tricks it carries (CUR-2697).
// Large 3's row carries none, Apertus's all four, and the plan is built from that list. The plan is the
// same in every environment and for every person (CUR-4015): no flag and no environment check, so
// switching to Apertus in the picker keeps the crutches it needs and nothing else moves a turn. (CUR-2420)

import { ALL_TRICKS, tricksFor, type HarnessTrick } from "$lib/chat/server/harnessProfiles";
import { evalLayers, markEvalLayerApplied } from "$lib/chat/server/evalLayers";

export type HarnessPlan = {
	/** A label for logs and specs: "native" when the turn carries no trick. Nothing branches on it. */
	kind: "native" | "scaffolded";
	/** "minimal": identity, honesty and crisis clauses plus one line per tool. "persona": today's prompt. */
	prompt: "minimal" | "persona";
	/** "tools": RAG and web search are tools the model calls. "pipeline": pre-turn retrieval and decision. */
	retrieval: "tools" | "pipeline";
	/** The GLM turn planner and its ledger (mathRouting.ts). */
	mathRouting: boolean;
	/** The honesty stream and grounded-bail regeneration around the answer. */
	streamGuards: boolean;
	/** "model": the model's own defaults. "grounded": GROUNDED_DECODING over them. */
	decoding: "model" | "grounded";
};

const NATIVE: HarnessPlan = {
	kind: "native",
	prompt: "minimal",
	retrieval: "tools",
	mathRouting: false,
	// The honesty stream holds base guards every model gets (the crisis-line reorder, fabricated URL and
	// citation checks), so native runs it too (CUR-2697). It intervened on 0 of 30 native search turns at
	// no time cost (CUR-2697 eval), so it costs nothing when the model behaves.
	streamGuards: true,
	decoding: "model",
};

/** Whether a turn sends no decoding overrides, leaving the model's own defaults (CUR-2420). A turn with
 *  no plan keeps GROUNDED_DECODING. */
export function usesModelDecoding(plan: HarnessPlan | undefined): boolean {
	return plan?.decoding === "model";
}

/** The plan a set of tricks makes: each trick turns on exactly one field, and no trick is NATIVE. */
export function planFromTricks(tricks: ReadonlySet<HarnessTrick>): HarnessPlan {
	if (tricks.size === 0) return NATIVE;
	return {
		kind: "scaffolded",
		prompt: tricks.has("fewShotPersona") ? "persona" : "minimal",
		retrieval: tricks.has("preTurnRetrieval") ? "pipeline" : "tools",
		mathRouting: tricks.has("mathPlanner"),
		streamGuards: true,
		decoding: tricks.has("groundedDecoding") ? "grounded" : "model",
	};
}

type TurnModel = { id?: string; name?: string; supportsTools?: boolean };

/**
 * The tricks this model's row names (CUR-2697). A model that cannot call tools also takes pre-turn
 * retrieval, since the native shape's retrieval is tools it would have to call. A row that names none
 * was vetted with tools only, so without them it gets every trick; a row that names some keeps the
 * rest off (CUR-3898: a model listed without tools gets the persona back, CUR-3835).
 */
function modelTricks(model: TurnModel): ReadonlySet<HarnessTrick> {
	const row = tricksFor(model.id ?? model.name);
	if (model.supportsTools) return row;
	return row.size ? new Set([...row, "preTurnRetrieval"]) : new Set(ALL_TRICKS);
}

/** The plan this model's row makes: every trick for a model with no row or no tool support. */
export function resolveHarness(model: TurnModel): HarnessPlan {
	return planFromTricks(modelTricks(model));
}

/** The plan for this turn's model, the same in every environment and for every person (CUR-4015). */
export function harnessForTurn(model: TurnModel): HarnessPlan {
	const tricks = modelTricks(model);
	// The layer test's per-trick switch: the row minus the named tricks. The gate behind it keeps it off
	// production. A model without tools keeps pre-turn retrieval, and the turn reports only what it took
	// off, so the runner sees the mismatch.
	const drop = evalLayers()?.dropTricks;
	if (drop) {
		const dropped = drop.filter((t) => tricks.has(t) && (t !== "preTurnRetrieval" || model.supportsTools));
		markEvalLayerApplied("dropTricks", dropped);
		return planFromTricks(new Set([...tricks].filter((t) => !dropped.includes(t))));
	}
	return planFromTricks(tricks);
}
