import glossary from "./glossary.json";

// Render-time CORRECT-or-strip of confabulated acronym expansions, ported from
// the original gap-chat (app/src/components/chat/markdown.jsx) and the
// ai-chatbot fork (chat/lib/text/fix-acronyms.ts). A model can invent (often wrong)
// parentheticals like "vLLM (Vector-Level Language Model)" despite the prompt
// forbidding it, so we fix them deterministically before render:
//   - a known acronym (our app-owned glossary) → its REAL expansion;
//   - an unknown/ambiguous one (e.g. vLLM, whose expansion is unofficial) → bare.
// Only touches acronym-shaped tokens; keeps genuine asides (e.g., i.e., numbers,
// URLs). Handles the mid-stream UNCLOSED "(…" so nothing flickers. Render-only —
// the raw text is still persisted for feedback/eval.

const GLOSS: Record<string, string> = Object.fromEntries(
	Object.entries(glossary as Record<string, string>)
		.filter(([k]) => !k.startsWith("_"))
		.map(([k, v]) => [k.toLowerCase(), v])
);

const isAcronymTok = (tok: string) => (tok.match(/[A-Z]/g) || []).length >= 2 && tok.length <= 6;

const isAside = (s: string) => /^\s*(e\.?\s?g|i\.?\s?e|see|or\b|and\b|\d|https?:|"|')/i.test(s);

const fixTok = (tok: string) => {
	const g = GLOSS[tok.toLowerCase()];
	return g ? `${tok} (${g})` : tok; // correct if known, else strip to bare
};

export function fixAcronymExpansions(text: string): string {
	if (!text) {
		return text;
	}
	return text
		.replace(
			/\b([A-Za-z][A-Za-z0-9.+-]{1,7})\s+\(([^()]{1,90})\)/g,
			(m, tok: string, inner: string) => (isAcronymTok(tok) && !isAside(inner) ? fixTok(tok) : m)
		)
		.replace(
			/\b([A-Za-z][A-Za-z0-9.+-]{1,7})\s+\(([^()]{0,90})$/,
			(m, tok: string, inner: string) => (isAcronymTok(tok) && !isAside(inner) ? fixTok(tok) : m)
		);
}
