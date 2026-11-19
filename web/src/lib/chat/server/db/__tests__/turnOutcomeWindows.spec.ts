/**
 * countTurnOutcomeWindows against the real turn_outcomes table. The unit spec beside the
 * module mocks the database, so only this file shows the FILTER clauses put each row in the windows
 * its age says, and that the layer and model written by recordTurnOutcome come back to the burn rate.
 */
import { afterEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { newId } from "$lib/chat/server/db/ids";
import { turnOutcomes } from "$lib/chat/server/db/schema";
import { countTurnOutcomeWindows, recordTurnOutcome } from "$lib/chat/server/db/turnOutcomes";

const MODEL = `turnOutcomeWindowsSpec:${crypto.randomUUID()}`;
const OTHER = `${MODEL}:other`;

afterEach(async () => {
	await getDb()
		.delete(turnOutcomes)
		.where(inArray(turnOutcomes.model, [MODEL, OTHER]));
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function insertAt(m: number, outcome: string, failureLayer: string | null, model = MODEL) {
	await getDb()
		.insert(turnOutcomes)
		.values({ id: newId(), outcome, declineKind: null, failureLayer, model, createdAt: minutesAgo(m) });
}

const mine = async (model = MODEL) => (await countTurnOutcomeWindows()).filter((r) => r.model === model);

describe("countTurnOutcomeWindows against Postgres", () => {
	it("counts each turn in every window its age falls inside, and none past 6 hours", async () => {
		await insertAt(2, "error", "upstream"); // 5m, 30m, 1h, 6h
		await insertAt(20, "error", "upstream"); // 30m, 1h, 6h
		await insertAt(45, "error", "upstream"); // 1h, 6h
		await insertAt(120, "error", "upstream"); // 6h
		await insertAt(400, "error", "upstream"); // none

		const rows = await mine();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ outcome: "error", failureLayer: "upstream" });
		expect(rows[0].counts).toEqual({ "5m": 1, "30m": 2, "1h": 3, "6h": 4 });
	});

	it("keeps outcome, layer and model apart, so a host's failures never count as ours", async () => {
		await insertAt(1, "error", "ours");
		await insertAt(1, "error", "upstream");
		await insertAt(1, "complete", null);
		await insertAt(1, "error", "upstream", OTHER);

		const rows = await mine();
		const key = (r: { outcome: string; failureLayer: string | null }) => `${r.outcome}/${r.failureLayer}`;
		expect(rows.map(key).sort()).toEqual(["complete/null", "error/ours", "error/upstream"]);
		expect((await mine(OTHER)).map(key)).toEqual(["error/upstream"]);
	});

	it("reads back the layer and served model recordTurnOutcome wrote", async () => {
		await recordTurnOutcome("timedOut", null, null, { failureLayer: "upstream", model: MODEL });

		const rows = await mine();
		expect(rows).toEqual([
			{
				outcome: "timedOut",
				failureLayer: "upstream",
				model: MODEL,
				counts: { "5m": 1, "30m": 1, "1h": 1, "6h": 1 },
			},
		]);
	});
});
