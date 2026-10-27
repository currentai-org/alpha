// per-request layer switches for the layer-by-layer test, a 2×2×2 factorial over the prompt
// block, retrieval and the max_tokens cap. The runner sets an `eval_layers` cookie holding JSON such as
// `{"promptBlock":false,"retrieval":true,"maxTokens":4096}` on its own conversation-API session.
//
// It rides the same gate as the `fuzz_override` cookie (flags.ts `fuzzOverrideEnabled()`): never read in
// production, whatever the cookie says, and on other deployments only where FUZZ_OVERRIDE_ENABLED is set.
// A visitor cannot reach it.
//
// Every turn that carries the cookie reports what it actually applied (`evalLayers` on the finished update, and one log
// line), and the runner fails the sample when that differs from what it asked for. A switch that stops
// taking effect, e.g. a tuning-panel persona with no few-shot block to remove, then shows up as an
// error instead of reading as "this layer has no effect". (CUR-2139)
import { z } from "zod";
import { getRequestContext } from "$lib/chat/server/requestContext";
import { ALL_TRICKS, type HarnessTrick } from "$lib/chat/server/harnessProfiles";

export const EVAL_LAYERS_COOKIE = "eval_layers";

const EvalLayersSchema = z
	.object({
		/** false: no guard paragraph in the user turn, and the persona without its few-shot examples. */
		promptBlock: z.boolean(),
		/** false: no retrieval for the turn. */
		retrieval: z.boolean(),
		/** The turn's max_tokens, over whatever the decoding would otherwise send. */
		maxTokens: z.number().int().min(1).max(16384),
		/** The honesty stream and grounded-bail regen around the answer, over the harness plan's. (CUR-2697) */
		streamGuards: z.boolean(),
		/** false: the scaffolded turn gets the base guards (native.ts `guardsOnlyPrompt`), not the persona. (CUR-2331) */
		persona: z.boolean(),
		/** Tricks taken off this turn's model row, so each can be A/B'd on the model that carries it. (CUR-2697) */
		dropTricks: z.array(z.enum(ALL_TRICKS as [HarnessTrick, ...HarnessTrick[]])).min(1).max(ALL_TRICKS.length),
	})
	.partial()
	.strict();

export type EvalLayers = z.infer<typeof EvalLayersSchema>;

/** Parse the cookie's value. Anything malformed is undefined, so a bad cookie changes nothing. */
export function parseEvalLayers(raw: string | undefined): EvalLayers | undefined {
	if (!raw) return undefined;
	try {
		const parsed = EvalLayersSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

/** This request's switches; undefined unless hooks/handle.ts stored them behind the gate. */
export function evalLayers(): EvalLayers | undefined {
	return getRequestContext()?.evalLayers;
}

/** What a turn actually applied, written back by the code that applies each switch. */
export interface AppliedEvalLayers {
	promptBlock?: boolean;
	retrieval?: boolean;
	maxTokens?: number;
	streamGuards?: boolean;
	persona?: boolean;
	/** The tricks actually taken off: only ones the row carried, and never pre-turn retrieval from a model without tools. */
	dropTricks?: HarnessTrick[];
}

/** Record one switch as applied, so the turn can report it. */
export function markEvalLayerApplied<K extends keyof AppliedEvalLayers>(
	key: K,
	value: AppliedEvalLayers[K]
): void {
	const ctx = getRequestContext();
	if (!ctx?.evalLayers) return;
	ctx.evalLayersApplied = { ...ctx.evalLayersApplied, [key]: value };
}

export function appliedEvalLayers(): AppliedEvalLayers | undefined {
	return getRequestContext()?.evalLayersApplied;
}

const FEW_SHOT_START = "How you behave, shown by example:";
const FEW_SHOT_END = "Honesty:";

/**
 * The persona with its few-shot block removed, or null when the markers are not both present (a
 * tuning-panel persona, or a template that has moved them), so the caller can report it unapplied.
 */
export function withoutFewShot(persona: string): string | null {
	const start = persona.indexOf(FEW_SHOT_START);
	const end = start < 0 ? -1 : persona.indexOf(FEW_SHOT_END, start);
	if (start < 0 || end < 0) return null;
	return persona.slice(0, start) + persona.slice(end);
}
