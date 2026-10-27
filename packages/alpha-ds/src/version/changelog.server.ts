/**
 * The changelog as page data for /designsystem. Server-only: the baseline entry carries the full
 * surface snapshot, which has no business in a client bundle. Built from the same files and the
 * same fold as `pnpm ds:version`, so the page and the CLI cannot disagree.
 */
import { marked } from 'marked';
import { foldLedger, type Bump } from './ledger.ts';
import type { ChangelogData } from './types.ts';

const files = import.meta.glob<string>('../changelog/*.md', {
	query: '?raw',
	import: 'default',
	eager: true
});

const ledger = foldLedger(
	Object.fromEntries(
		Object.entries(files)
			.filter(([path]) => !path.endsWith('/README.md'))
			.map(([path, raw]) => [path.split('/').pop()!.slice(0, -3), raw])
	)
);

/** `prop Dialog.Popup.size` → `prop`. */
const kindOf = (line: string) => line.split(' ')[0];

export const DS_VERSION = ledger.version;

export function changelogData(): ChangelogData {
	const counts: Record<Bump, number> = { major: 0, minor: 0, patch: 0 };
	for (const r of ledger.releases) counts[r.bump]++;
	return {
		version: ledger.version,
		counts,
		surfaceSize: ledger.surface.size,
		releases: ledger.releases.map((r) => {
			const kinds: Record<string, number> = {};
			if (r.baseline)
				for (const l of r.surface.added) kinds[kindOf(l)] = (kinds[kindOf(l)] ?? 0) + 1;
			return {
				id: r.id,
				version: r.version,
				date: r.date,
				bump: r.bump,
				summary: r.summary,
				notesHtml: r.notes ? (marked.parse(r.notes, { async: false }) as string) : '',
				baseline: r.baseline,
				added: r.baseline ? [] : r.surface.added,
				removed: r.surface.removed,
				kinds
			};
		})
	};
}
