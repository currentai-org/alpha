// Take a phone number the model wrote out of a crisis answer unless it is one we can vouch for (CUR-4061).
//
// CRISIS_AND_VALUES_CLAUSE (persona.ts) tells the model never to write a helpline number from memory.
// Not every model follows it: models can write France's 3114 as 3115 or invent a number for a named
// service. A wrong number given
// to someone in crisis does harm, so the prompt cannot be the control.
//
// The guard never reads the person's words. A turn counts as a crisis answer when the conversation is
// stamped `moderation.support`, or when the answer itself names findahelpline or 988, since writing
// one is the model deciding it is a crisis. 112 is not a sign: it is the emergency number every stroke,
// overdose or police answer names, and counting it would rewrite Russia's ambulance number, Spain's
// 016 and the "30-90" in a naloxone answer into findahelpline links. Outside a crisis answer nothing
// is touched, so a bank's number or a price is safe.
//
// 112 stays, because the clause names it; 988 stays only for a visitor in the US or Canada, where it is
// the crisis line; and so does the visitor's own emergency number from crisisLocale.ts, which cites a
// source for each. A national line in NATIONAL_LINES below stays for every visitor, like the emergency
// numbers: a crisis answer is often about another country, so a visitor in Hong Kong asking about a
// pupil in France keeps 3114 (CUR-4488). Any country's police, ambulance or fire number stays too
// (EMERGENCY_SERVICES). Every other run of three or more digits that reads as a phone number becomes a
// link to findahelpline.com's front page, where the person picks their country and ThroughLine keeps
// the verified line current. The link names no country: the model's words around a replaced number
// ("the national suicide line") describe the country the person asked about, so pointing them at the IP
// country's page would present another country's page as that national line (CUR-4488).
// When the person's message names the country (the support classifier reads it, in any language), the
// link and the support card both go to that country's page instead.
// Only digits are matched, so it works the same in any language.
//
// A number the turn's search sources really contain is replaced too, since the stream carries source
// titles and URLs and never their text. The visitor loses nothing, because findahelpline lists it.

import { crisisLocale } from "$lib/chat/crisisLocale";

/** Always kept: the EU emergency number, which the clause names and the 112 sentence inserts. */
const ALWAYS_ALLOWED = new Set(["112"]);

// 988 is the Suicide & Crisis Lifeline in the US and, since 2023-11-30, Canada's 9-8-8 line
// (https://988.ca). Anywhere else it reaches nobody, so it is kept only for a visitor in one of these.
const LINE_988_COUNTRIES = new Set(["us", "ca"]);

// National lines kept for every visitor, digits only. Each comes from its operator's own
// page; re-read the page before adding or changing one. Short, toll-free, state-run or
// long-standing lines only, since a number here is said to someone in crisis without a second check.
const NATIONAL_LINES: Record<string, string[]> = {
	// 016, gender-based violence, Ministerio de Igualdad:
	// https://violenciagenero.igualdad.gob.es/informacion-3/recursos/telefono016/
	// 024, suicidal behaviour, Ministerio de Sanidad: https://www.sanidad.gob.es/linea024/home.htm
	es: ["016", "024"],
	// 3114, suicide prevention, national line: https://3114.fr/
	// 3919, violence against women, French government: https://arretonslesviolences.gouv.fr/
	fr: ["3114", "3919"],
	// 116 123, Samaritans, UK and Republic of Ireland:
	// https://www.samaritans.org/how-we-can-help/contact-samaritan/
	gb: ["116123"],
	ie: ["116123"],
	// 0800 111 0 111 and 0800 111 0 222, TelefonSeelsorge: https://www.telefonseelsorge.de/
	de: ["08001110111", "08001110222"]
};

// Police, ambulance and fire numbers of any country, kept for every visitor (CUR-4122). A crisis answer
// can be about another country, and a Russian question about a beaten neighbour
// asked from a US address would lose Russia's police number 102 to a findahelpline link. These are the
// three-digit codes in the police, ambulance and fire columns of Wikipedia's "List of emergency
// telephone numbers", less entries that came from a notes cell: Turkey's 153 and
// 183-187 and Bangladesh's 333. 988 stays under LINE_988_COUNTRIES. The cost: an emergency number the
// model gives for the wrong country survives, where a recalled helpline number (four or more digits,
// or 187, which a model gave as France's Samu) is still replaced.
const EMERGENCY_SERVICES = new Set(
	(
		"000 011 019 022 033 061 062 080 085 089 091 092 100 101 102 103 104 105 106 107 108 109 110 111 " +
		"112 113 114 115 116 117 118 119 120 121 122 123 124 125 127 128 129 130 131 132 133 140 141 144 " +
		"150 151 155 158 160 163 166 170 171 175 177 180 190 191 192 193 194 195 197 198 199 211 311 511 " +
		"555 811 888 907 910 911 912 913 917 919 922 933 939 945 977 990 991 992 993 994 995 996 997 998 999"
	).split(" ")
);

// The crisis resources only a crisis answer names. Their presence makes an answer a crisis answer.
const OUR_RESOURCE = /findahelpline|(?<![\d-])\b988\b(?![\d-])/i;

// A phone-shaped run: optional +, then 3 to 15 digits, single spaces, no-break spaces, dots or hyphens
// allowed between them. Not glued to a letter, digit or decimal, and not a citation marker like [12].
const PHONE = /(?<![\p{L}\p{N}[+]|\d[.,])\+?\d(?:[ \u00a0.-]?\d){2,14}(?![\p{L}\p{N}\]]|[.,]\d)/gu;

// Kept even in a crisis answer: a year on its own, a date written with dots, a clock time.
const YEAR = /^(?:19|20)\d\d$/;
const DOTTED_DATE = /^\d{1,2}\.\d{1,2}\.\d{2,4}$/;
// A range of two short numbers, "30-90" minutes or "2-3" doses: a quantity, never a phone number.
const RANGE = /^\d{1,3} ?- ?\d{1,3}$/;

// Spans a number inside must never be rewritten: a URL, or a markdown link's target.
const URL_SPAN = /\]\([^)\s]*\)|https?:\/\/[^\s)\]]+|www\.[^\s)\]]+/gi;

export interface HelplineNumberResult {
	/** at least one number was replaced */
	replaced: boolean;
	/** the digits of each replaced number, for the log line */
	numbers: string[];
	/** the text with every replacement made; the ORIGINAL when nothing was */
	cleaned: string;
}

/** Whether `text` reads as a crisis answer on its own: it names findahelpline or 988. */
export function namesOurCrisisResource(text: string): boolean {
	return OUR_RESOURCE.test(text);
}

/**
 * Replace every unvouched phone number in `text` with a link to findahelpline.com. The caller decides
 * that the answer is a crisis answer; this only rewrites numbers. `country` is the visitor's
 * `x-vercel-ip-country` value, or null. `named` is the country the person's message places the person
 * at risk in, as the support classifier read it (CUR-4488): the link then goes to that country's page,
 * since the model's words around the number describe that country, and its emergency number and 988
 * (for the US or Canada) survive. With no named country the link is the front page, never the IP
 * country's page.
 */
export function guardHelplineNumbers(
	text: string,
	country: string | null | undefined,
	named?: string | null
): HelplineNumberResult {
	const allowed = new Set([...ALWAYS_ALLOWED, ...EMERGENCY_SERVICES]);
	for (const cc of [country, named]) {
		const emergency = crisisLocale(cc)?.emergency;
		if (emergency) allowed.add(emergency);
		if (LINE_988_COUNTRIES.has(cc?.trim().toLowerCase() ?? "")) allowed.add("988");
	}
	for (const line of Object.values(NATIONAL_LINES).flat()) allowed.add(line);
	const namedLocale = crisisLocale(named);
	const link = `[findahelpline.com](${namedLocale?.helplineUrl ?? "https://findahelpline.com"})`;

	const protectedSpans: Array<[number, number]> = [];
	for (const m of text.matchAll(URL_SPAN)) protectedSpans.push([m.index, m.index + m[0].length]);
	const inUrl = (at: number) => protectedSpans.some(([s, e]) => at >= s && at < e);

	const numbers: string[] = [];
	const cleaned = text.replace(PHONE, (match, at: number) => {
		const digits = match.replace(/\D/g, "");
		if (digits.length < 3 || allowed.has(digits)) return match;
		if (YEAR.test(match) || DOTTED_DATE.test(match) || RANGE.test(match) || inUrl(at)) return match;
		numbers.push(digits);
		return link;
	});
	return numbers.length ? { replaced: true, numbers, cleaned } : { replaced: false, numbers, cleaned: text };
}
