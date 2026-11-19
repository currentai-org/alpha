/**
 * A scheduled production probe's declined turn writes a safety_events row with `probe` set
 * (probeMarker.ts). Every count of real declines leaves those rows out: the fail-closed alert's
 * numerator, the run-code tier hold, and the /admin/safety list. A visitor's row (probe null) still
 * counts in all three. Runs against real Postgres, since the filter is SQL.
 */
import { afterEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { newId } from "$lib/chat/server/db/ids";
import {
	accountDeclinedSince,
	countFailClosedChildDeclines,
	listDeclines,
} from "$lib/chat/server/db/safetyEvents";

const HOUR = 60 * 60_000;
const inserted: string[] = [];

/** A fail-closed child-safety row (label = the fallback "child_safety"), probe-marked or not. */
async function insertDecline(opts: { probe?: string; userId?: string; kind?: "child_safety" | "content_policy" }) {
	const id = newId();
	const kind = opts.kind ?? "child_safety";
	await getDb()
		.insert(schema.safetyEvents)
		.values({
			id,
			kind,
			label: kind === "child_safety" ? "child_safety" : "harmful",
			userId: opts.userId ?? `cur4721-${crypto.randomUUID()}`,
			probe: opts.probe ?? null,
		});
	inserted.push(id);
	return id;
}

afterEach(async () => {
	if (inserted.length) await getDb().delete(schema.safetyEvents).where(inArray(schema.safetyEvents.id, inserted));
	inserted.length = 0;
});

describe.sequential("countFailClosedChildDeclines: probe rows are not an outage signal", () => {
	it("does not count a probe's fail-closed row", async () => {
		const before = await countFailClosedChildDeclines(HOUR);
		await insertDecline({ probe: "synthetic-turn" });
		expect(await countFailClosedChildDeclines(HOUR)).toBe(before);
	});

	it("still counts a visitor's unmarked fail-closed row beside a probe's, and only that one", async () => {
		const before = await countFailClosedChildDeclines(HOUR);
		await insertDecline({ probe: "synthetic-turn" });
		await insertDecline({});
		expect(await countFailClosedChildDeclines(HOUR)).toBe(before + 1);
	});
});

describe.sequential("accountDeclinedSince: a probe's decline does not hold an account", () => {
	it("is false for an account whose only decline is a probe's", async () => {
		const userId = `cur4721-${crypto.randomUUID()}`;
		await insertDecline({ userId, kind: "content_policy", probe: "chat-trajectory-probe" });
		expect(await accountDeclinedSince(userId, new Date(Date.now() - HOUR))).toBe(false);
	});

	it("is still true for an account with a visitor's unmarked decline", async () => {
		const userId = `cur4721-${crypto.randomUUID()}`;
		await insertDecline({ userId, kind: "content_policy" });
		expect(await accountDeclinedSince(userId, new Date(Date.now() - HOUR))).toBe(true);
	});
});

describe.sequential("listDeclines: /admin/safety lists visitors' declines, not probes'", () => {
	it("leaves out a probe's row and still lists the visitor's unmarked row beside it", async () => {
		const probeRow = await insertDecline({ probe: "alpha-demo-probe" });
		const visitorRow = await insertDecline({});
		const ids = (await listDeclines()).map((r) => r.id);
		expect(ids).not.toContain(probeRow);
		expect(ids).toContain(visitorRow);
	});
});
