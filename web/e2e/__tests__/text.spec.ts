import { describe, it, expect } from 'vitest';
import { phrase } from '../scenarios/helpers/text';

// The DOM text the journey gallery actually renders. +page.svelte:209-210 wraps this sentence
// mid-line, so Svelte emits a real newline and four tabs into the middle of it — copied here rather
// than paraphrased, because the whole defect is that the whitespace is not what it looks like.
const AS_RENDERED =
	'dumpling @ dd2e2b67,\n\t\t\t\t19 September 08:13 UTC, signed out, agent off,\n' +
	'\t\t\t\tweb search off, desktop only — mobile recording is off';

describe('phrase', () => {
	// Asserted first, and in the direction that proves this helper is load-bearing rather than
	// decorative. A regex without this helper cannot match a sentence the page renders correctly (CUR-1598). If
	// this ever starts returning true the helper has stopped being necessary, and that is worth
	// failing over.
	it('a literal space finds nothing once the template wraps — the reason this file exists', () => {
		expect(/signed out, agent (on|off), web search (on|off)/i.test(AS_RENDERED)).toBe(false);
	});

	it('matches a sentence the template split across lines', () => {
		expect(phrase('signed out, agent off, web search off').test(AS_RENDERED)).toBe(true);
	});

	it('still fails on text that is genuinely absent, not merely rewrapped', () => {
		expect(phrase('signed out, agent on, web search off').test(AS_RENDERED)).toBe(false);
	});

	// The argument is prose. A matcher that silently read `isn't` as a quantifier, or `(set X)` as a
	// capture group, would match something other than what its caller typed — and on a negative
	// assertion it would match nothing at all and pass vacuously.
	it('treats its argument as prose, not as a pattern', () => {
		expect(
			phrase("Password login isn't configured").test("Password login isn't\n  configured")
		).toBe(true);
		expect(phrase('a.c').test('abc')).toBe(false);
		expect(phrase('(set ADMIN_USER)').test('(set   ADMIN_USER)')).toBe(true);
	});

	it('is case-insensitive by default, and takes flags when a caller needs otherwise', () => {
		expect(phrase('Web Search Off').test(AS_RENDERED)).toBe(true);
		expect(phrase('Web Search Off', '').test(AS_RENDERED)).toBe(false);
	});
});
