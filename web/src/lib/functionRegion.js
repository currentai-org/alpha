// Which Vercel region the functions run in, read by svelte.config.js at build time. Every database
// query crosses from the function to the database and back, so the functions belong in the database's
// region. A PR preview's own database is a Neon branch in Frankfurt (the CI database branch) while Vercel's
// default region is iad1, and that crossing cost about 188 ms per query against 8 ms on develop,
// enough to queue a 150-user load run behind its connection pool.
//
// FUNCTION_REGION, when set, wins: production names fra1 itself. Unset, the region follows the Neon
// host in DATABASE_URL (or POSTGRES_URL). A URL that names no Neon region we map gives no region, and
// Vercel keeps its default.

/** Neon's AWS regions, as they appear in a Neon host, to the nearest Vercel function region. */
const NEON_TO_VERCEL = {
	'us-east-1': 'iad1',
	'us-east-2': 'cle1',
	'us-west-2': 'pdx1',
	'eu-central-1': 'fra1',
	'eu-west-2': 'lhr1',
	'ap-southeast-1': 'sin1',
	'ap-southeast-2': 'syd1',
	'sa-east-1': 'gru1'
};

/**
 * The Vercel region beside a Neon database URL, or undefined when the URL names no mapped Neon region.
 * @param {string | undefined} url
 * @returns {string | undefined}
 */
export function regionBesideDatabase(url) {
	const raw = url?.trim();
	if (!raw) return undefined;
	let host;
	try {
		host = new URL(raw).hostname;
	} catch {
		return undefined;
	}
	const m = /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(host);
	return m ? NEON_TO_VERCEL[/** @type {keyof typeof NEON_TO_VERCEL} */ (m[1])] : undefined;
}

/**
 * The function regions for this build: FUNCTION_REGION's comma-separated list when it names any,
 * otherwise the region beside the database, otherwise none (Vercel's default).
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function functionRegionsFor(env) {
	const named = (env.FUNCTION_REGION ?? '')
		.split(',')
		.map((r) => r.trim())
		.filter(Boolean);
	if (named.length) return named;
	const beside = regionBesideDatabase(env.DATABASE_URL ?? env.POSTGRES_URL);
	return beside ? [beside] : [];
}
