import { describe, it, expect } from "vitest";

// LIVE CONTRACT CHECK against the real Coop API.
//
// The HERMETIC half already exists: moderation.spec.ts asserts what our parser does with a given shape
// (200 + actionsTriggered[] → ok; 200 without it → UNKNOWN; an entry lacking a string `name` → UNKNOWN).
// What nothing checked is the other half — whether Coop STILL RETURNS that shape. A vendor can rename a
// field and ship it as a 200, which no uptime monitor and no hermetic test can see.
//
// WHY THIS ONE FIRST, ahead of every other vendor. checkChildSafety fails CLOSED on UNKNOWN, and
// "bad shape" maps to UNKNOWN. So a silent schema change at Coop does not degrade anything — it
// DECLINES EVERY TURN, while Coop keeps answering 200 and every dependency probe stays green. To a user
// it looks like the model refusing people.
//
// Asserts the INVARIANTS moderation.ts actually depends on, nothing more. Extra fields are fine; the
// test must not fail because Coop added something. It fails when a field we PARSE stops being there.
//
// Gated on COOP_LIVE=1 and needs prod Coop credentials, so it runs in the nightly workflow, never on a
// PR — a vendor's bad minute must not red someone's unrelated change.

const LIVE = process.env.COOP_LIVE === "1";
const URL_BASE = (process.env.COOP_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.COOP_API_KEY || "";
const ITEM_TYPE = process.env.COOP_ITEM_TYPE || "";

const ready = LIVE && Boolean(URL_BASE && API_KEY && ITEM_TYPE);

describe.skipIf(!ready)("Coop verdict contract (live)", () => {
	it("returns 200 with actionsTriggered[] for benign text — the shape checkChildSafety depends on", async () => {
		const res = await fetch(`${URL_BASE}/api/v1/content`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": API_KEY },
			body: JSON.stringify({
				contentType: ITEM_TYPE,
				contentId: crypto.randomUUID(),
				content: { text: "What is the capital of Switzerland?" },
				sync: true,
			}),
			signal: AbortSignal.timeout(30_000),
		});

		// A non-2xx maps to UNKNOWN in getCoopVerdict, which fail-CLOSES child safety.
		expect(res.status, "non-2xx from Coop maps to UNKNOWN and declines every turn").toBe(200);

		const body = await res.json();

		// THE invariant. getCoopVerdict treats a 200 without a proper actionsTriggered array as UNKNOWN
		// rather than clean — deliberately, so this field disappearing declines every turn instead of
		// silently allowing all.
		expect(Array.isArray(body?.actionsTriggered), "actionsTriggered[] missing ⇒ UNKNOWN ⇒ every turn declines").toBe(true);

		// Each entry must carry a string `name`; one that does not maps the WHOLE verdict to UNKNOWN.
		for (const entry of body.actionsTriggered) {
			expect(typeof entry?.name, "an entry without a string name maps the verdict to UNKNOWN").toBe(
				"string"
			);
		}
	});

	it("still accepts the request body we send — a schema rejection is an outage, not a 4xx to ignore", async () => {
		// Mirrors postContent() exactly, minus the author field (which has its own 400-retry path).
		const res = await fetch(`${URL_BASE}/api/v1/content`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": API_KEY },
			body: JSON.stringify({
				contentType: ITEM_TYPE,
				contentId: crypto.randomUUID(),
				content: { text: "hello" },
				sync: true,
			}),
			signal: AbortSignal.timeout(30_000),
		});
		expect(res.status, "Coop rejecting our request shape ⇒ UNKNOWN ⇒ fail-closed declines").toBe(200);
	});
});
