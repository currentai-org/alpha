import { describe, expect, it } from "vitest";
import prodTurns from "./fixtures/turnSpeed-prod-2026-09-28-to-10-13.json";
import { TURN_SPEED_WINDOW_MS, turnSpeedVerdict } from "./turnSpeedVerdict";

// Prod assistant turns with a first-token time (a 15-day window), as [time, ttftMs], oldest first. Time
// and TTFT only.
const turns = (prodTurns as [string, number][]).map(([at, ttft]) => ({ at: Date.parse(at), ttft }));

/** The verdict the cron would have read just after each turn: the newest turns in the window, newest first. */
function replay() {
	return turns.map((turn, i) => {
		const ttfts: number[] = [];
		for (let j = i; j >= 0 && turn.at - turns[j].at <= TURN_SPEED_WINDOW_MS; j--) ttfts.push(turns[j].ttft);
		return { at: new Date(turn.at).toISOString(), ...turnSpeedVerdict(ttfts) };
	});
}

const SPELL_START = Date.parse("2026-10-12T22:00:00Z");
const SPELL_END = Date.parse("2026-10-13T00:00:00Z");

describe("turnSpeedVerdict replayed over prod's turns, 28 Sep to 13 Oct (CUR-2243)", () => {
	const verdicts = replay();

	it("reads slow during 12 Oct 22:00Z, when guests waited a median 12s for Large 3 and 22s for Medium", () => {
		const slow = verdicts.filter((v) => v.kind === "slow");
		expect(slow.length).toBeGreaterThan(0);
		expect(slow.some((v) => v.at.startsWith("2026-10-12T22"))).toBe(true);
	});

	it("reads slow on no full window outside that spell, so it does not cry wolf on healthy days", () => {
		const outside = verdicts.filter(
			(v) => v.kind === "slow" && (Date.parse(v.at) < SPELL_START || Date.parse(v.at) >= SPELL_END)
		);
		expect(outside).toEqual([]);
	});

	it("reaches a verdict on most turns, so silence outside the spell is a healthy reading and not a missing one", () => {
		const reached = verdicts.filter((v) => v.kind !== "no-verdict").length;
		expect(reached / verdicts.length).toBeGreaterThan(0.8); // 752 of 885 on a 12h window, 492 on 6h
	});
});

describe("turnSpeedVerdict", () => {
	const fast = Array.from({ length: 15 }, () => 3_000);

	// Injured the way it breaks: every answer still finishes and nothing errors, only the first words
	// come late. The rate alert reads that as healthy; this has to read it as slow.
	it("reads slow when answers still finish but the median first token is over 15s", () => {
		const slow = Array.from({ length: 15 }, (_, i) => 14_000 + i * 500); // median 17.5s
		expect(turnSpeedVerdict(slow)).toMatchObject({ kind: "slow", total: 15, medianTtftMs: 17_500 });
	});

	it("reads healthy on the same count of turns under the ceiling", () => {
		expect(turnSpeedVerdict(fast)).toMatchObject({ kind: "healthy", medianTtftMs: 3_000 });
	});

	it("reads healthy when a few slow turns sit among fast ones, as on a normal day with a 23s p90", () => {
		const mixed = [...fast.slice(0, 11), 23_000, 25_000, 28_000, 30_000];
		expect(turnSpeedVerdict(mixed).kind).toBe("healthy");
	});

	it("gives no verdict below 15 completed turns, however slow, so a quiet night neither raises nor clears it", () => {
		expect(turnSpeedVerdict(Array.from({ length: 14 }, () => 40_000))).toEqual({ kind: "no-verdict", total: 14 });
	});

	it("judges only the newest 15 turns, so an old slow stretch clears once fast answers replace it", () => {
		const recovered = [...fast, ...Array.from({ length: 15 }, () => 40_000)];
		expect(turnSpeedVerdict(recovered).kind).toBe("healthy");
	});
});
