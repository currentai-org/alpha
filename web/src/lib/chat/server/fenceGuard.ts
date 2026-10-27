// Shared fence-delimiter defense for untrusted retrieved/ingested content wrapped into a system
// prompt. A retrieved chunk could try to smuggle its own closing tag ("</retrieved_sources>") to
// escape the fence early and have its own injected text parsed as trusted instructions instead of
// quoted data. neutralizeFence strips any literal occurrence of the exact tag (open or close) from
// the untrusted text BEFORE it's wrapped, so the fence can't be forged from inside — the one real
// closing tag in the output is always the wrapper's own.
//
// Distinct from grounding.ts's hardenLastUserTurn(), which uses an UNGUESSABLE per-turn random tag
// for the user's own message (the highest-trust boundary, where a matching pre-crafted escape isn't
// possible even in principle). A fixed, well-known tag name is fine for retrieved evidence blocks
// because neutralizeFence defeats the escape attempt regardless of whether the tag name is guessable
// — extracted here so ragGrounding.ts and searchGrounding.ts share one implementation.
export function neutralizeFence(text: string, tag: string): string {
	return text.replace(new RegExp(`</?\\s*${tag}\\s*>`, "gi"), `[${tag}]`);
}
