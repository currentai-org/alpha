// Should THIS turn ask the model for a reasoning effort? (CUR-700)
//
// The per-user `reasoningOverrides` setting is a toggle the user set for a model at some point in the
// past — it says nothing about whether the model IN THIS REQUEST can actually use it. A model whose
// `supportsReasoning` is false must never receive `reasoning_effort`, no matter what a stale override
// says, the same reasoning `resolveForceMultimodal` (multimodalMode.ts) applies to a stale multimodal
// override: AND the override with the model's own current capability, don't let the override stand in
// for it.
//
// Without the model gate, a ternary like `(reasoningOverrides?.[model.id] ?? model.supportsReasoning) ?
// reasoningEffortOverrides?.[model.id] : undefined` lets an override of `true`, left over from a model
// that once supported reasoning (or from a model the picker never validated it against), survive the
// OR and forward a real `reasoning_effort` to a model that cannot use one.

import type { ReasoningEffort } from "$lib/chat/types/Settings";

/**
 * Resolve the `reasoning_effort` value to forward for this turn, or `undefined` to omit it.
 *
 * `override` is the user's per-model on/off preference (`reasoningOverrides[model.id]`); absent, it
 * defaults to the model's own capability — a reasoning-capable model reasons unless the user turned it
 * off, a non-capable one never does regardless of the default. `effort` is the actual effort level to
 * send when reasoning is on (`reasoningEffortOverrides[model.id]`).
 */
export function resolveReasoningEffort(opts: {
	supportsReasoning: boolean;
	override: boolean | undefined;
	effort: ReasoningEffort | undefined;
}): ReasoningEffort | undefined {
	if (!opts.supportsReasoning) return undefined;
	const wantsReasoning = opts.override ?? true;
	return wantsReasoning ? opts.effort : undefined;
}
