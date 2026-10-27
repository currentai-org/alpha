// Wraps @axe-core/playwright so every page-visit spec asserts the same contract instead
// of hand-rolling one. Scoped to `serious`/`critical` impact only: axe's `minor`/`moderate` findings
// are real but numerous enough on a first pass to bury the ones worth blocking a merge over; a gate that starts red on day one gets disabled (CUR-1511).
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = join(here, '..', 'a11y-allowlist.json');

interface A11yAllowlistEntry {
	page: string;
	rule: string;
	ticket: string;
	note: string;
}

let cachedAllowlist: A11yAllowlistEntry[] | null = null;
function loadAllowlist(): A11yAllowlistEntry[] {
	if (!cachedAllowlist) {
		cachedAllowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8'));
	}
	return cachedAllowlist!;
}

/**
 * Scans the page currently loaded in `page` and throws, with a readable report, on any
 * `serious`/`critical` violation not named in `a11y-allowlist.json` for this `pageName`. Allowlist
 * entries are keyed on `(page, rule)` together, so a real regression on a different page from an
 * allowlisted one still blocks.
 */
export async function assertNoSeriousA11yViolations(page: Page, pageName: string): Promise<void> {
	const results = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();

	const allowedRuleIds = new Set(
		loadAllowlist()
			.filter((entry) => entry.page === pageName)
			.map((entry) => entry.rule)
	);

	const blocking = results.violations.filter(
		(v) => (v.impact === 'serious' || v.impact === 'critical') && !allowedRuleIds.has(v.id)
	);

	if (blocking.length === 0) return;

	const report = blocking
		.map((v) => {
			const nodes = v.nodes
				.slice(0, 3)
				.map((n) => `      ${n.target.join(' ')}`)
				.join('\n');
			return `  [${v.impact}] ${v.id} — ${v.help}\n${nodes}`;
		})
		.join('\n');

	throw new Error(
		`${blocking.length} serious/critical accessibility violation(s) on "${pageName}", not on the ` +
			`allowlist:\n${report}\n\nFix them, or add a ticketed entry to e2e/scenarios/a11y-allowlist.json.`
	);
}
