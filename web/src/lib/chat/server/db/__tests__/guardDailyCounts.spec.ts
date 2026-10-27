/**
 * A distress (log-action) guard hit leaves a count and nothing else. The contracts: hits on one
 * UTC day and rule add up in a single row, and a row holds only the day, the rule and the count, so there
 * is no per-hit record to join back to a person. (CUR-3915)
 */
import { afterEach, describe, expect, it } from "vitest";
import { and, asc, getTableColumns, gte, lte } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { guardDailyCounts } from "$lib/chat/server/db/schema";
import { countGuardHitsSafe as countGuardHits } from "$lib/chat/server/db/guardDailyCounts";

// Every date here sits in 2001, so a real screen elsewhere in the stateful suite, which counts against
// today, can neither land in these rows nor be deleted by this spec.
const inTestYear = and(gte(guardDailyCounts.day, "2001-01-01"), lte(guardDailyCounts.day, "2001-12-31"));
const readCounts = () =>
	getDb()
		.select()
		.from(guardDailyCounts)
		.where(inTestYear)
		.orderBy(asc(guardDailyCounts.day), asc(guardDailyCounts.ruleKey));

describe.sequential("guard daily counts (CUR-3915)", () => {
	afterEach(async () => {
		await getDb().delete(guardDailyCounts).where(inTestYear);
	});

	it("hits on one UTC day and rule add up in one row; a new day or rule starts its own", async () => {
		const day1 = new Date("2001-10-17T00:00:01Z");
		const day1Late = new Date("2001-10-17T23:59:59Z");
		const day2 = new Date("2001-10-18T00:00:00Z");
		await countGuardHits(["chat-block-self-harm-intent"], day1);
		await countGuardHits(["chat-block-self-harm-intent", "chat-block-self-harm-passive"], day1Late);
		await countGuardHits(["chat-block-self-harm-intent"], day2);

		const rows = await readCounts();
		expect(rows).toEqual([
			{ day: "2001-10-17", ruleKey: "chat-block-self-harm-intent", count: 2 },
			{ day: "2001-10-17", ruleKey: "chat-block-self-harm-passive", count: 1 },
			{ day: "2001-10-18", ruleKey: "chat-block-self-harm-intent", count: 1 },
		]);
	});

	it("a rule repeated within one screen counts once, and an empty hit list writes nothing", async () => {
		const at = new Date("2001-10-17T12:00:00Z");
		await countGuardHits(["chat-block-self-harm-hedged", "chat-block-self-harm-hedged"], at);
		await countGuardHits([], at);
		expect(await readCounts()).toEqual([
			{ day: "2001-10-17", ruleKey: "chat-block-self-harm-hedged", count: 1 },
		]);
	});

	it("a row holds only day, rule and count: no id, time, user, session or conversation", () => {
		expect(Object.keys(getTableColumns(guardDailyCounts)).sort()).toEqual(["count", "day", "ruleKey"]);
	});
});
