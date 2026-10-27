import { describe, expect, it } from "vitest";
import { nextWeekendLine, runDatetime, todayLine } from "./datetimeTool";
import { nativeToolKit } from "./nativeTools";

// 2026-10-01 is a Thursday. 22:30 UTC is already Friday in Tokyo and still Thursday in New York.
const NOW = new Date("2026-10-01T22:30:00Z");
const call = (args: object | string) => ({
	id: "c1",
	name: "current_datetime",
	arguments: typeof args === "string" ? args : JSON.stringify(args),
});

describe("current_datetime (CUR-2276)", () => {
	it("reads the clock in the user's zone when the model names none", () => {
		expect(runDatetime(call({}), "Europe/Zurich", NOW).content).toBe(
			"Friday 2026-10-02 00:30 in Europe/Zurich (UTC+02:00). UTC now: 2026-10-01T22:30Z. The next Saturday after today is Saturday, 3 October 2026, and the next Sunday after today is Sunday, 4 October 2026."
		);
	});

	it("answers for a zone the model names, across the date line from the user", () => {
		expect(runDatetime(call({ timezone: "Asia/Tokyo" }), "America/Los_Angeles", NOW).content).toMatch(
			/^Friday 2026-10-02 07:30 in Asia\/Tokyo \(UTC\+09:00\)/
		);
		expect(runDatetime(call({}), "America/Los_Angeles", NOW).content).toMatch(
			/^Thursday 2026-10-01 15:30 in America\/Los_Angeles \(UTC-07:00\)/
		);
	});

	it("says a made-up zone is not one, rather than inventing its offset, and still gives the user's time", () => {
		const { content } = runDatetime(call({ timezone: "Mars/Olympus" }), "Europe/Zurich", NOW);
		expect(content).toMatch(/^"Mars\/Olympus" is not an IANA time zone/);
		expect(content).toContain("in Europe/Zurich (UTC+02:00)");
	});

	it("falls back to UTC when the visitor's zone is missing or unusable, and on unparseable arguments", () => {
		expect(runDatetime(call("{not json"), undefined, NOW).content).toBe(
			"Thursday 2026-10-01 22:30 in UTC (UTC+00:00). UTC now: 2026-10-01T22:30Z. The next Saturday after today is Saturday, 3 October 2026, and the next Sunday after today is Sunday, 4 October 2026."
		);
		expect(runDatetime(call({}), "Nowhere/Real", NOW).content).toContain("in UTC (UTC+00:00)");
	});

	it("is offered on native turns and routed by name to the clock", async () => {
		const kit = nativeToolKit({ locals: { timezone: "Asia/Tokyo" } as App.Locals, web: false });
		expect(kit.definitions.map((d) => d.function.name)).toContain("current_datetime");
		const { content } = await kit.run(call({}));
		expect(content).toMatch(/ in Asia\/Tokyo \(UTC\+09:00\)\. UTC now: /);
	});

	it("formats a half-hour offset zone with its minutes", () => {
		expect(runDatetime(call({ timezone: "Asia/Kolkata" }), undefined, NOW).content).toMatch(
			/^Friday 2026-10-02 04:00 in Asia\/Kolkata \(UTC\+05:30\)/
		);
	});
});

describe("current_datetime's day count (CUR-2276)", () => {
	// A model that sums month lengths itself can say 69 days from 16 October to Christmas; 70 is right.
	const OCT16 = new Date("2026-10-16T14:26:00Z");

	it("counts 70 days from 16 October to Christmas, where the model's own sum said 69", () => {
		const out = runDatetime(call({ date: "2026-12-25" }), "America/Los_Angeles", OCT16).content;
		expect(out).toContain("2026-12-25 is 70 days from today.");
	});

	it("counts from the visitor's own date when it is a day ahead of UTC", () => {
		// 22:30 UTC on 1 Oct is already 2 Oct in Tokyo, so 3 Oct is one day away there and two in New York.
		expect(runDatetime(call({ date: "2026-10-03" }), "Asia/Tokyo", NOW).content).toContain(
			"2026-10-03 is 1 day from today."
		);
		expect(runDatetime(call({ date: "2026-10-03" }), "America/New_York", NOW).content).toContain(
			"2026-10-03 is 2 days from today."
		);
	});

	it("says today, or how long ago, for today and a past date", () => {
		expect(runDatetime(call({ date: "2026-10-16" }), "UTC", OCT16).content).toContain("2026-10-16 is today.");
		expect(runDatetime(call({ date: "2026-01-01" }), "UTC", OCT16).content).toContain(
			"2026-01-01 was 288 days ago."
		);
	});

	it("refuses a date that is not a real calendar day rather than rolling it over", () => {
		const out = runDatetime(call({ date: "2026-02-30" }), "UTC", OCT16).content;
		expect(out).toContain('"2026-02-30" is not a YYYY-MM-DD calendar date');
		expect(out).not.toMatch(/days? (from today|ago)/);
	});
});

describe("current_datetime's weekend (CUR-4164)", () => {
	// 01:35 UTC on 18 October is Sunday in Auckland and still Saturday the 17th in Los Angeles.
	const SUNDAY_AUCKLAND = new Date("2026-10-18T01:35:00Z");

	it("on a Sunday, gives this coming Saturday as six days ahead, never the day before", () => {
		expect(nextWeekendLine("Pacific/Auckland", SUNDAY_AUCKLAND)).toBe(
			"The next Saturday after today is Saturday, 24 October 2026, and the next Sunday after today is Sunday, 25 October 2026."
		);
		expect(runDatetime(call({}), "Pacific/Auckland", SUNDAY_AUCKLAND).content).toContain(
			"The next Saturday after today is Saturday, 24 October 2026"
		);
	});

	it("on a Saturday, gives tomorrow as the next Sunday and a week out as the next Saturday", () => {
		expect(nextWeekendLine("America/Los_Angeles", SUNDAY_AUCKLAND)).toBe(
			"The next Saturday after today is Saturday, 24 October 2026, and the next Sunday after today is Sunday, 18 October 2026."
		);
	});

	it("counts from the visitor's own date, a day ahead of UTC, and from UTC for a made-up zone", () => {
		// 2026-10-02 22:30 UTC is Friday in UTC and already Saturday 3 October in Tokyo.
		const friday = new Date("2026-10-02T22:30:00Z");
		expect(nextWeekendLine("Asia/Tokyo", friday)).toContain("next Sunday after today is Sunday, 4 October 2026");
		expect(nextWeekendLine("Asia/Tokyo", friday)).toContain("next Saturday after today is Saturday, 10 October 2026");
		expect(nextWeekendLine("Nowhere/Real", friday)).toContain("next Saturday after today is Saturday, 3 October 2026");
	});
});

describe("the prompt's date line (CUR-2276)", () => {
	it("names the weekday and date in the visitor's zone, which can be a day ahead of UTC", () => {
		expect(todayLine("Asia/Tokyo", NOW)).toBe("Friday, 2 October 2026 (Asia/Tokyo)");
		expect(todayLine("America/New_York", NOW)).toBe("Thursday, 1 October 2026 (America/New_York)");
	});

	it("agrees with current_datetime on the weekday and date when the visitor's day differs from UTC's", () => {
		for (const zone of ["Asia/Tokyo", "America/Los_Angeles"]) {
			const [weekday, isoDate] = runDatetime(call({}), zone, NOW).content.split(" ");
			const day = String(Number(isoDate.slice(8, 10)));
			expect(todayLine(zone, NOW)).toMatch(new RegExp(`^${weekday}, ${day} `));
		}
	});

	it("falls back to UTC, and says so, for a missing or made-up zone", () => {
		expect(todayLine(undefined, NOW)).toBe("Thursday, 1 October 2026 (UTC)");
		expect(todayLine("Mars/Olympus", NOW)).toBe("Thursday, 1 October 2026 (UTC)");
	});
});
