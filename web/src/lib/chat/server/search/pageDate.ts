// The date a page we already fetched says it was published, read from the metadata the fetch returned,
// so the model can tell an old press release from this month's figure (CUR-4147). Firecrawl's scrape
// flattens a page's <meta> tags into one map, and each site uses its own key: gov.uk uses
// `govuk:public-updated-at`, Wikipedia `article:modified_time`, Reuters `DateModified`, arXiv
// `citation_date`, Save the Children `date`.
// A page read directly takes Readability's `publishedTime` instead, which already reads
// `article:published_time` and JSON-LD `datePublished`.

/** Metadata keys that carry a page's date, published before modified, compared case-insensitively.
 *  Left out on purpose: Firecrawl's own `cachedAt` (when Firecrawl fetched it, so usually today) and
 *  gov.uk's `govuk:updated-at`, which moves on any internal edit, a year after the public update. */
const DATE_KEYS = [
	"article:published_time",
	"og:article:published_time",
	"publishedtime",
	"datepublished",
	"parsely-pub-date",
	"citation_publication_date",
	"citation_date",
	"citation_online_date",
	"dc.date.issued",
	"dcterms.issued",
	"govuk:first-published-at",
	"govuk:public-updated-at",
	"article:modified_time",
	"og:updated_time",
	"modifiedtime",
	"datemodified",
	"dc:modified",
	"dcterms.modified",
	"date",
];

/** Pages older than this are almost always a template's placeholder date. */
const EARLIEST_YEAR = 1990;
const DAY_MS = 86_400_000;

/** The first usable date under `DATE_KEYS`, as YYYY-MM-DD, or undefined when none parses. */
export function pageDateFromMetadata(meta: Record<string, unknown> | undefined, nowMs = Date.now()): string | undefined {
	if (!meta) return undefined;
	const byKey = new Map(Object.entries(meta).map(([k, v]) => [k.toLowerCase(), v]));
	for (const key of DATE_KEYS) {
		const raw = byKey.get(key);
		// Firecrawl gives a repeated <meta> tag as an array.
		const day = isoDay(Array.isArray(raw) ? raw[0] : raw, nowMs);
		if (day) return day;
	}
	return undefined;
}

/** A metadata date as YYYY-MM-DD. Undefined for anything unparsed, before 1990, or after tomorrow,
 *  so a bad value leaves the source undated and is never read as today. */
export function isoDay(raw: unknown, nowMs = Date.now()): string | undefined {
	if (typeof raw !== "string") return undefined;
	const s = raw.trim();
	let y: number, m: number, d: number;
	const ymd = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(s);
	// Drupal's default "medium" format, D, m/d/Y - H:i (Save the Children's `date`).
	const drupal = /^[A-Z][a-z]{2}, (\d{2})\/(\d{2})\/(\d{4}) - \d{2}:\d{2}$/.exec(s);
	if (ymd) [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
	else if (drupal) [y, m, d] = [Number(drupal[3]), Number(drupal[1]), Number(drupal[2])];
	else if (/[A-Za-z]{3}/.test(s) && /\b\d{4}\b/.test(s) && Number.isFinite(Date.parse(s))) {
		// A written-out date such as "Tue, 01 Oct 2024 10:00:00 GMT", whose month is a word, so no
		// day/month order to guess.
		const t = new Date(Date.parse(s));
		[y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
	} else return undefined;
	const t = Date.UTC(y, m - 1, d);
	const back = new Date(t);
	if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return undefined;
	if (y < EARLIEST_YEAR || t > nowMs + DAY_MS) return undefined;
	return back.toISOString().slice(0, 10);
}
