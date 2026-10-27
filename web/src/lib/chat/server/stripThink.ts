// Thinking models (GLM, Qwen, …) emit a <think>…</think> block before the answer. Pure leaf so it can
// be unit-tested without the second-opinion endpoint's heavy imports (models.ts throws at import w/o env).
export function stripThink(t: string): string {
	// 1) Complete blocks.
	let out = t.replace(/<think>[\s\S]*?<\/think>/gi, "");
	// 2) An UNCLOSED trailing <think>: the model hit its token cap while still reasoning, so there's no
	//    </think> — without this the entire raw chain-of-thought leaks in as the "answer". Drop from the
	//    open tag to the end. (Callers treat an empty result as a failed/dropped output, so a model that
	//    never escaped its think block is dropped, not shown as reasoning-masquerading-as-an-answer.)
	out = out.replace(UNCLOSED_THINK, "");
	return out.trim();
}

const UNCLOSED_THINK = /<think>[\s\S]*$/i;

/**
 * Did stripThink empty this output because the model never escaped its think block? True only when an
 * unclosed `<think>` was the reason nothing survives — the token cap fired mid-reasoning.
 *
 * Exists so a caller can tell three outcomes apart that all reduce to an empty string: the model ran
 * out of budget while still reasoning, the model returned nothing at all, and the call failed. They
 * would otherwise be one silent `null` in the second-opinion panel, where a structural failure
 * looks like slow models (CUR-149).
 */
export function droppedUnclosedThink(raw: string): boolean {
	if (stripThink(raw).length > 0) return false;
	return UNCLOSED_THINK.test(raw.replace(/<think>[\s\S]*?<\/think>/gi, ""));
}
