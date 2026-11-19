// Accept-header content negotiation (RFC 9110 section 12.5.1) for the few routes that serve a
// Markdown sibling of an HTML page.

type Range = { range: string; q: number; rank: number; pos: number };

// How specific a media range is: an exact type beats `type/*`, which beats `*/*`.
function rankOf(range: string): number {
	if (range === '*/*') return 0;
	return range.endsWith('/*') ? 1 : 2;
}

function parseRanges(header: string): Range[] {
	const out: Range[] = [];
	header.split(',').forEach((item, pos) => {
		const [rawRange, ...params] = item.split(';');
		const range = rawRange.trim().toLowerCase();
		if (!range) return;
		let q = 1;
		for (const p of params) {
			const eq = p.indexOf('=');
			if (eq < 0 || p.slice(0, eq).trim().toLowerCase() !== 'q') continue;
			const n = Number(p.slice(eq + 1).trim());
			if (Number.isFinite(n)) q = Math.min(1, Math.max(0, n));
		}
		out.push({ range, q, rank: rankOf(range), pos });
	});
	return out;
}

function covers(range: string, type: string): boolean {
	if (range === '*/*' || range === type) return true;
	return range.endsWith('/*') && type.startsWith(range.slice(0, -1));
}

/**
 * Picks which of `offered` (listed in the server's order of preference) the Accept header allows.
 * The most specific range covering a type decides its q-value; a q of 0 rules it out. The highest
 * q wins, and between equals the range the client listed first wins. A missing or empty header
 * accepts everything, so the first offered type is returned. Returns null when nothing is allowed.
 */
export function negotiateType(header: string | null, offered: readonly string[]): string | null {
	const ranges = header ? parseRanges(header) : [];
	if (ranges.length === 0) return offered[0] ?? null;

	let best: { type: string; q: number; pos: number } | null = null;
	for (const type of offered) {
		let deciding: Range | null = null;
		for (const r of ranges) {
			if (!covers(r.range, type)) continue;
			if (
				!deciding ||
				r.rank > deciding.rank ||
				(r.rank === deciding.rank && r.pos < deciding.pos)
			) {
				deciding = r;
			}
		}
		if (!deciding || deciding.q <= 0) continue;
		if (!best || deciding.q > best.q || (deciding.q === best.q && deciding.pos < best.pos)) {
			best = { type, q: deciding.q, pos: deciding.pos };
		}
	}
	return best?.type ?? null;
}

/** Adds `Accept` to the response's Vary header unless it is already listed. */
export function addVaryAccept(headers: Headers): void {
	const current = headers.get('vary');
	if (!current) {
		headers.set('Vary', 'Accept');
		return;
	}
	const listed = current.split(',').map((t) => t.trim().toLowerCase());
	if (!listed.includes('accept') && !listed.includes('*'))
		headers.set('Vary', `${current}, Accept`);
}
