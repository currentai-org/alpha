// Shadow pass for rendered answer HTML (CUR-4130).
//
// `marked.ts` stays the sanitizer of record: its output is what the reader sees. This module runs
// DOMPurify over that same output in the browser and reports what DOMPurify WOULD have removed,
// by name only (never content), so a later change can make DOMPurify the final pass with evidence
// that it does not strip KaTeX, highlight classes, citation links or media. DOMPurify needs a DOM,
// so this never runs on the server or in the markdown worker.
import type { Config, DOMPurify } from 'dompurify';

/** What our renderer emits that DOMPurify's defaults would drop: link targets, media controls. */
const ANSWER_PURIFY_CONFIG: Config = {
	USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
	// semantics/annotation: KaTeX wraps its MathML in them, and DOMPurify's MathML profile omits both.
	ADD_TAGS: ['video', 'audio', 'source', 'semantics', 'annotation'],
	ADD_ATTR: ['target', 'controls', 'translate', 'encoding'],
	// DOMPurify keeps <style> by default; a style element is a CSS-breakout channel, so it goes.
	FORBID_TAGS: ['style'],
	// Return a string and leave the removed list readable on the instance.
	RETURN_DOM: false,
	RETURN_DOM_FRAGMENT: false
};

/** `tag:script`, `attr:onerror@img`: names only, so a report can never carry answer text. */
export function sanitizerDiff(html: string, purify: DOMPurify): string[] {
	purify.sanitize(html, ANSWER_PURIFY_CONFIG);
	const seen = new Set<string>();
	for (const item of purify.removed) {
		if ('attribute' in item && item.attribute) {
			const from = item.from?.nodeName?.toLowerCase() ?? '?';
			seen.add(`attr:${item.attribute.name.toLowerCase()}@${from}`);
		} else if ('element' in item && item.element) {
			seen.add(`tag:${item.element.nodeName.toLowerCase()}`);
		}
	}
	return [...seen].sort();
}

const reported = new Set<string>();
const MAX_REPORTS = 20;

/** Reports each distinct difference once per page load, at most MAX_REPORTS in all. */
export function reportSanitizerDiff(
	diff: string[],
	send: (name: string, props: Record<string, unknown>) => void
): void {
	if (diff.length === 0 || reported.size >= MAX_REPORTS) return;
	const signature = diff.join(',');
	if (reported.has(signature)) return;
	reported.add(signature);
	send('answer_html_sanitizer_diff', { removed: diff });
}

let purifyPromise: Promise<DOMPurify> | null = null;

/** Lazy, browser-only: the DOMPurify import stays out of the SSR and worker bundles' hot path. */
export function loadPurify(): Promise<DOMPurify> {
	purifyPromise ??= import('dompurify').then((m) => m.default);
	return purifyPromise;
}
