// The current date and time, read from the server's clock rather than guessed from the
// model's training cutoff. Offered on native turns beside calculate; the model decides when
// to call it. The visitor's own zone (sent with each turn) is the default, so "what day is it" means
// their day, and a named IANA zone answers "what time is it in Tokyo".

import type { NativeToolResult, StreamedToolCall } from "../endpoints/types";

export const DATETIME_TOOL = {
	type: "function",
	function: {
		name: "current_datetime",
		description:
			"The current date, time and weekday from the server clock. Call it for anything that depends on today's date or the time now: what day it is, how long until or since a date, someone's age, a deadline. Never assume the date from memory. For how many days until or since a date, pass it as `date` and quote the count this returns; don't add up month lengths yourself or with calculate.",
		parameters: {
			type: "object",
			properties: {
				timezone: {
					type: "string",
					description:
						"An IANA time zone such as Europe/Zurich or Asia/Tokyo. Leave it out for the user's own zone.",
				},
				date: {
					type: "string",
					description:
						"A calendar date as YYYY-MM-DD. The result then also gives the whole days from today, in the same zone, to that date, or how many days ago it was.",
				},
			},
			additionalProperties: false,
		},
	},
} as const;

function argsOf(call: StreamedToolCall): { timezone?: string; date?: string } {
	try {
		const a = JSON.parse(call.arguments || "{}") as { timezone?: unknown; date?: unknown };
		const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
		return { timezone: str(a.timezone), date: str(a.date) };
	} catch {
		return {};
	}
}

/** The clock's fields for `zone` at `now`, by part name (year, month, weekday, timeZoneName, …). */
function clockParts(now: Date, zone: string): Record<string, string> {
	return Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			weekday: "long",
			timeZoneName: "longOffset",
		})
			.formatToParts(now)
			.map((p) => [p.type, p.value])
	);
}

/** Today's calendar date in `zone`, as a UTC-midnight timestamp so two dates subtract to whole days. */
function localDayMs(now: Date, zone: string): number {
	const p = clockParts(now, zone);
	return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
}

/**
 * The day count to `date` from today in `zone`. A model adding month lengths itself can miscount
 * (69 days from 16 October to Christmas, where 70 is right), so the count comes from here.
 */
function describeDaysTo(date: string, now: Date, zone: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	const target = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
	if (!m || new Date(target).getUTCDate() !== Number(m[3])) {
		return ` "${date}" is not a YYYY-MM-DD calendar date, so no day count is given.`;
	}
	const days = Math.round((target - localDayMs(now, zone)) / 86_400_000);
	if (days === 0) return ` ${date} is today.`;
	const n = Math.abs(days);
	return days > 0
		? ` ${date} is ${n} day${n === 1 ? "" : "s"} from today.`
		: ` ${date} was ${n} day${n === 1 ? "" : "s"} ago.`;
}

function isZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

/**
 * The next Saturday and Sunday after today in `zone`. Asked on a Sunday for "this coming Saturday",
 * a model can name the day before even with today right, so the weekend comes from here too.
 */
export function nextWeekendLine(userZone: string | undefined, now = new Date()): string {
	const zone = userZone && isZone(userZone) ? userZone : "UTC";
	const today = localDayMs(now, zone);
	const weekday = new Date(today).getUTCDay();
	const after = (target: number) => {
		const days = (target - weekday + 7) % 7 || 7;
		return new Intl.DateTimeFormat("en-GB", {
			timeZone: "UTC",
			weekday: "long",
			day: "numeric",
			month: "long",
			year: "numeric",
		}).format(today + days * 86_400_000);
	};
	return `The next Saturday after today is ${after(6)}, and the next Sunday after today is ${after(0)}.`;
}

/** "Saturday 2026-11-07 20:15 in Pacific/Auckland (UTC+13:00)": weekday, date, clock and offset. */
function clockReading(now: Date, zone: string): string {
	const parts = clockParts(now, zone);
	const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName.replace("GMT", "");
	return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} in ${zone} (UTC${offset})`;
}

/** The clock reading for `zone` at `now`, in words the model can quote and arithmetic it can trust. */
function describeNow(now: Date, zone: string): string {
	return `${clockReading(now, zone)}. UTC now: ${now.toISOString().slice(0, 16)}Z. ${nextWeekendLine(zone, now)}`;
}

// IANA city names that are also an everyday word, a holiday, a given name or surname, or a better-known
// place elsewhere, so "Christmas", "Casey" or "Norfolk" never reads as Indian/Christmas,
// Antarctica/Casey or Pacific/Norfolk. Picked from the zone list against a dictionary; a city a person
// rarely means (Center, Troll) costs nothing to leave out, since the UTC clock is still the fallback.
const CITY_NAMES_THAT_ARE_WORDS = new Set([
	"Beulah",
	"Canary",
	"Casey",
	"Center",
	"Christmas",
	"Davis",
	"Dawson",
	"Easter",
	"Jersey",
	"Knox",
	"Midway",
	"Monticello",
	"Norfolk",
	"Oral",
	"Palmer",
	"Regina",
	"Resolute",
	"Reunion",
	"Stanley",
	"Troll",
	"Wake",
]);

let cityZones: Map<string, string> | undefined;

/** Each IANA zone by its city as written in prose: "Auckland" → Pacific/Auckland, "New York" →
 *  America/New_York. Built from the runtime's own zone list, so it never drifts from what `isZone` takes. */
function zonesByCity(): Map<string, string> {
	if (cityZones) return cityZones;
	cityZones = new Map();
	for (const zone of Intl.supportedValuesOf("timeZone")) {
		if (!zone.includes("/") || zone.startsWith("Etc/")) continue;
		const city = zone.slice(zone.lastIndexOf("/") + 1).replaceAll("_", " ");
		if (!CITY_NAMES_THAT_ARE_WORDS.has(city)) cityZones.set(city, zone);
	}
	return cityZones;
}

const isCapitalised = (word: string | undefined) => !!word && word[0] !== word[0].toLowerCase();

/**
 * The IANA zones whose city `text` names, in the order named, at most four. Case-sensitive, as a place
 * name is written: "Auckland" and "New York" count, "new york" does not. A city inside a longer name
 * does not count either: in "New Jersey" or "Tokyo Tower" a capitalised word runs straight on from it.
 * A place the zone list has no city for (a country, a state, a city that shares another's zone) is not
 * found, and the model is left to work the time out from the UTC clock itself.
 */
export function zonesNamedIn(text: string | undefined): string[] {
	if (!text) return [];
	const byCity = zonesByCity();
	// Each word with what separates it from the next, so a sentence break ("Honolulu. What") is not
	// read as one name running on.
	const words = [...text.matchAll(/\p{L}+/gu)].map((m) => ({ word: m[0], start: m.index, end: m.index + m[0].length }));
	const joined = (a: number, b: number) => /^ +$/.test(text.slice(words[a].end, words[b].start));
	const found: string[] = [];
	for (let i = 0; i < words.length && found.length < 4; i++) {
		// The longest name first, so "Port Moresby" is one place and not a miss on "Port".
		for (let n = Math.min(3, words.length - i); n >= 1; n--) {
			const last = i + n - 1;
			if (n > 1 && !joined(last - 1, last)) continue;
			const zone = byCity.get(words.slice(i, i + n).map((w) => w.word).join(" "));
			if (!zone) continue;
			const runsOn =
				(i > 0 && joined(i - 1, i) && isCapitalised(words[i - 1].word)) ||
				(last + 1 < words.length && joined(last, last + 1) && isCapitalised(words[last + 1].word));
			if (!runsOn && !found.includes(zone)) found.push(zone);
			i = last;
			break;
		}
	}
	return found;
}

/**
 * The server's clock in each of `zones`, to sit beside a searched turn's sources. A model given only
 * the UTC clock and cached clock pages can get the zone offset arithmetic wrong, so the reading is
 * done here, the way `current_datetime` does it.
 */
export function placeClocksLine(zones: readonly string[], now = new Date()): string {
	const real = zones.filter(isZone);
	if (!real.length) return "";
	// The 12-hour reading too: given a 24-hour time such as 21:19 alone, a model can misread it as "9:19 AM".
	const twelve = (z: string) =>
		new Intl.DateTimeFormat("en-US", { timeZone: z, hour: "numeric", minute: "2-digit", hour12: true })
			.format(now)
			.replace(/\s/g, " ")
			.toLowerCase();
	return `The server's clock in the time zones whose city the question names: ${real.map((z) => `${clockReading(now, z)}, which is ${twelve(z)} there`).join("; ")}. Where the question asks about one of these zones' places, give this day and time, never a source's time and never one worked out from an offset; a zone it does not ask about is not an answer.`;
}

/**
 * The date line of the system prompt: weekday, date and zone, from the clock and zone the tool reads,
 * so the two never disagree. A bare ISO date leaves the weekday to the model, which can misname it
 * even after reading the tool.
 */
export function todayLine(userZone: string | undefined, now = new Date()): string {
	const zone = userZone && isZone(userZone) ? userZone : "UTC";
	const date = new Intl.DateTimeFormat("en-GB", {
		timeZone: zone,
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	}).format(now);
	return `${date} (${zone})`;
}

/**
 * Runs one `current_datetime` call. A zone the model names but that isn't a real IANA zone is said
 * so in the result, with the answer for the user's zone, so the model can't present a made-up offset.
 */
export function runDatetime(
	call: StreamedToolCall,
	userZone: string | undefined,
	now = new Date()
): NativeToolResult {
	const fallback = userZone && isZone(userZone) ? userZone : "UTC";
	const { timezone: asked, date } = argsOf(call);
	if (asked && !isZone(asked)) {
		return {
			content: `"${asked}" is not an IANA time zone, so no time is given for it. ${describeNow(now, fallback)}${date ? describeDaysTo(date, now, fallback) : ""}`,
		};
	}
	const zone = asked ?? fallback;
	return { content: describeNow(now, zone) + (date ? describeDaysTo(date, now, zone) : "") };
}
