// A page-text matcher that survives the template being rewrapped (CUR-1598).
//
// Playwright normalizes whitespace when `getByText` is handed a STRING and does NOT when it is
// handed a RegExp. Against the journey gallery's own `<p>`, whose Svelte source wraps
// mid-sentence so the rendered DOM carries `agent off,\n\t\t\t\tweb search off`:
//
//     /signed out, agent (on|off), web search (on|off)/i     -> 0 matches
//     /signed out,\s+agent (on|off),\s+web search (on|off)/i -> 1 match
//     'signed out, agent off, web search off'                -> 1 match
//
// So a literal space inside a regex matcher is a bet that the phrase never straddles a line break
// in the template it came from, and that bet is lost by a reflow — an edit nobody reviews for test
// impact. `journey-gallery.spec.ts` once asserted that config line and could
// not have passed while the page rendered the sentence correctly.
//
// The worse half is a NEGATIVE assertion. A regex that matches nothing satisfies `toBeHidden()`
// and `toHaveCount(0)` vacuously, so the check reports green having guarded nothing — this repo's
// "a check that cannot go red is not a check" in a costume that nothing else in the suite catches.

/** Build a page-text matcher from a sentence as a person would read it, where every run of
 *  whitespace accepts any run of whitespace.
 *
 *  The argument is PROSE, not a pattern: regex metacharacters in it are escaped, so `isn't` and
 *  `(set ADMIN_USER)` mean themselves. A phrase that genuinely needs alternation has to be written
 *  as a regex by hand — put `\s+` everywhere a space would go, and this comment is the reason. */
export function phrase(text: string, flags = 'i'): RegExp {
	const literal = text.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(literal.replace(/\s+/g, '\\s+'), flags);
}
