/** Changelog page data — shared by changelog.server.ts and the /designsystem page. */
import type { Bump } from './ledger.ts';

export interface ChangelogRelease {
	id: string;
	version: string;
	date: string;
	bump: Bump;
	summary: string;
	notesHtml: string;
	baseline: boolean;
	added: string[];
	removed: string[];
	/** For a baseline: how many names of each kind the snapshot holds. */
	kinds: Record<string, number>;
}

export interface ChangelogData {
	version: string;
	counts: Record<Bump, number>;
	surfaceSize: number;
	releases: ChangelogRelease[];
}
