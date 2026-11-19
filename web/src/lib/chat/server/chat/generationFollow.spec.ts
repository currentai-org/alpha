import { describe, expect, it } from "vitest";
import { createFollowStream, type FollowDeps } from "./generationFollow";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";

const line = (o: object) => JSON.stringify(o);
const stream = (token: string) => line({ type: MessageUpdateType.Stream, token });
const final = (text: string) => line({ type: MessageUpdateType.FinalAnswer, text, interrupted: false });

async function run(deps: Partial<FollowDeps> & Pick<FollowDeps, "readEvents">, after?: number) {
	let t = 0;
	const body = createFollowStream(
		{
			isTerminal: async () => false,
			savedFinalAnswer: async () => undefined,
			now: () => t,
			sleep: async (ms) => void (t += ms),
			...deps,
		},
		{ after }
	);
	const text = await new Response(body).text();
	return text
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as { type: string; token?: string; text?: string; status?: string });
}

describe("generation follow stream", () => {
	it("replays the log in order and ends at the logged FinalAnswer", async () => {
		const rows = [
			{ seq: 0, payload: stream("a") + "\n" + stream("b") },
			{ seq: 1, payload: final("ab") },
		];
		const out = await run({ readEvents: async (after) => rows.filter((r) => r.seq > after) });
		expect(out.filter((u) => u.type === MessageUpdateType.Stream).map((u) => u.token)).toEqual(["a", "b"]);
		expect(out.at(-1)).toMatchObject({ type: MessageUpdateType.FinalAnswer, text: "ab" });
	});

	it("starts after the given offset", async () => {
		const rows = [
			{ seq: 0, payload: stream("a") },
			{ seq: 1, payload: stream("b") },
			{ seq: 2, payload: final("ab") },
		];
		const out = await run({ readEvents: async (after) => rows.filter((r) => r.seq > after) }, 0);
		expect(out.filter((u) => u.type === MessageUpdateType.Stream).map((u) => u.token)).toEqual(["b"]);
	});

	it("sends the saved (stop-clamped) FinalAnswer in place of the logged one", async () => {
		const rows = [{ seq: 0, payload: stream("a") + "\n" + final("a and more after the stop") }];
		const out = await run({
			readEvents: async (after) => rows.filter((r) => r.seq > after),
			savedFinalAnswer: async () => ({ type: MessageUpdateType.FinalAnswer, text: "a", interrupted: true }),
		});
		expect(out.at(-1)).toMatchObject({ text: "a", interrupted: true });
		expect(JSON.stringify(out)).not.toContain("and more after the stop");
	});

	it("keeps polling while the log is quiet, then picks up rows written later", async () => {
		let polls = 0;
		const out = await run({
			readEvents: async (after) => {
				polls++;
				if (polls < 3) return [];
				return after < 0 ? [{ seq: 0, payload: final("late") }] : [];
			},
		});
		expect(polls).toBe(3);
		expect(out.filter((u) => u.status === "keepAlive").length).toBeGreaterThan(0);
		expect(out.at(-1)).toMatchObject({ text: "late" });
	});

	it("a terminal generation with no logged FinalAnswer ends with the saved one", async () => {
		const out = await run({
			readEvents: async () => [],
			isTerminal: async () => true,
			savedFinalAnswer: async () => ({ type: MessageUpdateType.FinalAnswer, text: "saved", interrupted: false }),
		});
		expect(out).toEqual([expect.objectContaining({ text: "saved" })]);
	});

	it("ends when the producer goes quiet past the stale window, without a FinalAnswer", async () => {
		const out = await run({ readEvents: async () => [], staleMs: 1000, pollMs: 400 });
		expect(out.some((u) => u.type === MessageUpdateType.FinalAnswer)).toBe(false);
	});

	it("cancelling the reader ends only the follow loop", async () => {
		let reads = 0;
		const body = createFollowStream(
			{ readEvents: async () => (reads++, []), isTerminal: async () => false, savedFinalAnswer: async () => undefined, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), pollMs: 5 },
			{}
		);
		const reader = body.getReader();
		await reader.read();
		await reader.cancel();
		const seen = reads;
		await new Promise((r) => setTimeout(r, 50));
		expect(reads - seen).toBeLessThanOrEqual(1);
	});

	it("a follow with no offset replays seq 0, the opening sentence", async () => {
		const rows = [
			{ seq: 0, payload: stream("opening") },
			{ seq: 1, payload: final("opening") },
		];
		const out = await run({ readEvents: async (after) => rows.filter((r) => r.seq > after) });
		expect(out.filter((u) => u.type === MessageUpdateType.Stream).map((u) => u.token)).toEqual(["opening"]);
	});

	it("after a Stop, waits for the clamped save and never emits the unclamped logged FinalAnswer", async () => {
		const rows = [{ seq: 0, payload: stream("a") + "\n" + final("a plus text the stop cut off") }];
		let terminalChecks = 0;
		let saved: { type: MessageUpdateType; text: string; interrupted: boolean } | undefined;
		const out = await run({
			readEvents: async (after) => rows.filter((r) => r.seq > after),
			isTerminal: async () => {
				terminalChecks++;
				if (terminalChecks >= 3) saved = { type: MessageUpdateType.FinalAnswer, text: "a", interrupted: true };
				return terminalChecks >= 3;
			},
			savedFinalAnswer: async () => saved as never,
		});
		expect(terminalChecks).toBeGreaterThanOrEqual(3);
		expect(out.filter((u) => u.type === MessageUpdateType.FinalAnswer)).toEqual([
			expect.objectContaining({ text: "a", interrupted: true }),
		]);
	});
});
