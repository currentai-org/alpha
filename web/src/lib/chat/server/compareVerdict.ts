import type { Message } from "$lib/chat/types/Message";

export type Verdict = NonNullable<Message["verdict"]>;

/**
 * Why a verdict is what it is. `parsed` is the aggregator's own verdict; every other code is the
 * neutral fallback, and the code says which step lost it (CUR-2082). `no_answer` covers a timeout,
 * a transport error, an empty reply and reasoning that used the whole budget; the route's
 * `reason` field on the same log line tells those apart.
 */
export type VerdictOutcome = "parsed" | "no_answer" | "no_json" | "bad_json";

function asStringList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v
		.map((x) => String(x).trim())
		.filter(Boolean)
		.slice(0, 8);
}

// Extract the verdict JSON from the aggregator's output. Falls back to a neutral
// verdict (never fabricates agreement) when parsing fails.
export function parseVerdict(
	raw: string | null,
	n: number,
	hasPrimary: boolean
): { verdict: Verdict; outcome: VerdictOutcome } {
	const plural = n === 1 ? "" : "s";
	const fallback: Verdict = {
		agreement: "mixed",
		// Honest in BOTH cases: only claim "compared this answer" when a primary answer
		// actually existed to compare against (see the aggInput branch). With no primary,
		// the panel only weighed in among itself — don't assert a comparison that didn't run.
		headline: hasPrimary
			? `Compared this answer against ${n} independent open model${plural} — see their takes below.`
			: `${n} independent open model${plural} weighed in on this question — see their takes below.`,
		consensus: [],
		contradictions: [],
		weakSpots: [],
	};
	if (!raw) return { verdict: fallback, outcome: "no_answer" };
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return { verdict: fallback, outcome: "no_json" };
	try {
		const obj = JSON.parse(raw.slice(start, end + 1));
		const agreement = obj.agreement === "high" || obj.agreement === "low" ? obj.agreement : "mixed";
		const headline =
			typeof obj.headline === "string" && obj.headline.trim()
				? obj.headline.trim()
				: fallback.headline;
		return {
			verdict: {
				agreement,
				headline,
				consensus: asStringList(obj.consensus),
				contradictions: asStringList(obj.contradictions),
				weakSpots: asStringList(obj.weakSpots),
			},
			outcome: "parsed",
		};
	} catch {
		return { verdict: fallback, outcome: "bad_json" };
	}
}
