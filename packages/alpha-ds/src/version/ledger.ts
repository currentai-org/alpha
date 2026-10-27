/**
 * The design system's version ledger — pure logic, shared by the app, `scripts/ds-version.mjs`,
 * the lint plugin and the specs. No fs, no Vite, so Node can import it directly (type stripping).
 *
 * There is no version number to remember to bump. The version is DERIVED from the changelog:
 * every change is one file in `changelog/`, and
 *
 *   version = <majors>.<minors>.<patches>     (counts of entries by bump kind)
 *
 * Counters rather than semver's resets, on purpose: a sum does not depend on order, so two
 * branches that each add an entry land on the same version whichever merges first, and the
 * version only ever goes up. A major still means "something was removed or renamed".
 *
 * Each entry also carries a `surface` block — the public names it added (+) or removed (-).
 * Folding every block over the baseline snapshot must reproduce the surface extracted from the
 * code; if it does not, some change was never recorded, and `pnpm ds:version --check` says which.
 */

export const BUMPS = ['patch', 'minor', 'major'] as const;
export type Bump = (typeof BUMPS)[number];

export interface SurfaceDelta {
	added: string[];
	removed: string[];
}

export interface LedgerEntry {
	/** File name without `.md`, e.g. `2026-09-28-composer-chip`. Sort key and stable id. */
	id: string;
	/** `YYYY-MM-DD`, from the file name. */
	date: string;
	bump: Bump;
	summary: string;
	/** Markdown notes between the frontmatter and the surface block. */
	notes: string;
	/** A baseline entry's surface block is the full snapshot, not a delta. */
	baseline: boolean;
	surface: SurfaceDelta;
}

export interface Release extends LedgerEntry {
	/** The version this entry brought the system to (counts up to and including it). */
	version: string;
}

export interface Ledger {
	version: string;
	/** Newest first. */
	releases: Release[];
	/** Every surface line the ledger vouches for. */
	surface: Set<string>;
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9-]+$/;
const SURFACE_FENCE = /^```surface[^\n]*\n([\s\S]*?)^```\s*$/m;

export const bumpRank = (b: Bump) => BUMPS.indexOf(b);

/** What a surface delta demands: a removal breaks consumers, an addition extends them. */
export function requiredBump(delta: SurfaceDelta): Bump {
	if (delta.removed.length) return 'major';
	if (delta.added.length) return 'minor';
	return 'patch';
}

/** Parse one `changelog/<id>.md`. Throws with the file name so a typo fails loudly. */
export function parseEntry(id: string, raw: string): LedgerEntry {
	const where = `changelog/${id}.md`;
	const date = FILE_RE.exec(id)?.[1];
	if (!date) throw new Error(`${where}: name must be YYYY-MM-DD-<kebab-slug>.md`);

	const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
	if (!fm) throw new Error(`${where}: missing --- frontmatter ---`);
	const meta: Record<string, string> = {};
	for (const line of fm[1].split('\n')) {
		const m = /^(\w+):\s*(.*)$/.exec(line.trim());
		if (m) meta[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
	}

	const bump = meta.bump as Bump;
	if (!BUMPS.includes(bump)) throw new Error(`${where}: bump must be one of ${BUMPS.join(' | ')}`);
	if (!meta.summary) throw new Error(`${where}: summary is required`);

	let body = raw.slice(fm[0].length);
	const surface: SurfaceDelta = { added: [], removed: [] };
	const block = SURFACE_FENCE.exec(body);
	if (block) {
		body = body.slice(0, block.index) + body.slice(block.index + block[0].length);
		for (const line of block[1].split('\n')) {
			const t = line.trim();
			if (!t) continue;
			if (t.startsWith('+ ')) surface.added.push(t.slice(2).trim());
			else if (t.startsWith('- ')) surface.removed.push(t.slice(2).trim());
			else throw new Error(`${where}: surface lines start with "+ " or "- ", got "${t}"`);
		}
	}
	const baseline = meta.baseline === 'true';
	if (baseline && surface.removed.length)
		throw new Error(`${where}: a baseline snapshot only lists + lines`);
	if (!baseline && bumpRank(bump) < bumpRank(requiredBump(surface)))
		throw new Error(
			`${where}: bump is ${bump} but its surface block needs ${requiredBump(surface)} (` +
				(surface.removed.length ? 'it removes names' : 'it adds names') +
				')'
		);

	return {
		id,
		date,
		bump,
		summary: meta.summary,
		notes: body.replace(/<!--[\s\S]*?-->/g, '').trim(),
		baseline,
		surface
	};
}

/** Fold every entry into the current version, per-entry versions and the vouched-for surface. */
export function foldLedger(files: Record<string, string>): Ledger {
	const entries = Object.entries(files)
		.map(([id, raw]) => parseEntry(id, raw))
		.sort((a, b) => a.id.localeCompare(b.id));

	const baselines = entries.filter((e) => e.baseline);
	if (baselines.length > 1)
		throw new Error(`changelog: one baseline snapshot allowed, found ${baselines.length}`);

	const counts = { major: 0, minor: 0, patch: 0 };
	const releases: Release[] = entries.map((e) => {
		counts[e.bump]++;
		return { ...e, version: `${counts.major}.${counts.minor}.${counts.patch}` };
	});

	const surface = new Set(baselines[0]?.surface.added ?? []);
	for (const e of entries) {
		if (e.baseline) continue;
		for (const s of e.surface.removed) surface.delete(s);
		for (const s of e.surface.added) surface.add(s);
	}

	return {
		version: releases.at(-1)?.version ?? '0.0.0',
		releases: releases.reverse(),
		surface
	};
}

/** Lines in `actual` the ledger does not know about, and ledger lines the code no longer has. */
export function diffSurface(recorded: Set<string>, actual: Set<string>): SurfaceDelta {
	return {
		added: [...actual].filter((s) => !recorded.has(s)).sort(),
		removed: [...recorded].filter((s) => !actual.has(s)).sort()
	};
}

/** Render a surface block the way `ds:change` writes it (sorted, removals first). */
export function formatSurface(delta: SurfaceDelta): string {
	const lines = [
		...[...delta.removed].sort().map((s) => `- ${s}`),
		...[...delta.added].sort().map((s) => `+ ${s}`)
	];
	return lines.length ? '```surface\n' + lines.join('\n') + '\n```\n' : '';
}
