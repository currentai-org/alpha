import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB collection so setTuning's read/write hits an in-memory stub.
vi.mock("$lib/chat/server/database", () => ({
	collections: {
		config: {
			findOne: vi.fn(async () => null),
			updateOne: vi.fn(async () => ({})),
			deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
		},
	},
}));

import { parseTuning, TuningSchema, setTuning, clearTuning, TuningConflictError } from "./tuning";
import { collections } from "$lib/chat/server/database";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updateOne = vi.mocked((collections as any).config.updateOne);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deleteOne = vi.mocked((collections as any).config.deleteOne);
// Hoisted to file scope because more than one describe needs to reset it — see the note on the
// setTuning block below for what happens when a block assumes a clean `findOne` instead of setting one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findOneMock = vi.mocked((collections as any).config.findOne);

describe("parseTuning (fail-safe validation)", () => {
	it("accepts a valid partial doc and strips unknown keys (e.g. the row key)", () => {
		const out = parseTuning({
			key: "TUNING",
			persona: "You are a calm machine. You run on {model} by {maker}.",
			decoding: { temperature: 0.2, max_tokens: 400 },
			starters: ["What changed this week?"],
			editedBy: "editor",
			editedAt: "2026-06-18T00:00:00.000Z",
		});
		expect(out.persona).toContain("{model}");
		expect(out.decoding).toEqual({ temperature: 0.2, max_tokens: 400 });
		expect(out.starters).toEqual(["What changed this week?"]);
		expect(out).not.toHaveProperty("key");
	});

	it("returns {} (→ code defaults) for missing/null input", () => {
		expect(parseTuning(undefined)).toEqual({});
		expect(parseTuning(null)).toEqual({});
		expect(parseTuning({})).toEqual({});
	});

	it("fails safe to {} when a field is the wrong type", () => {
		expect(parseTuning({ persona: 123 })).toEqual({});
		expect(parseTuning({ starters: "not-an-array" })).toEqual({});
	});

	it("rejects out-of-range decoding values (fails safe to {})", () => {
		expect(parseTuning({ decoding: { temperature: 9 } })).toEqual({});
		expect(parseTuning({ decoding: { max_tokens: 0 } })).toEqual({});
	});

	it("caps starters count and rejects empty strings", () => {
		expect(parseTuning({ starters: Array(20).fill("x") })).toEqual({});
		expect(parseTuning({ starters: [""] })).toEqual({});
	});

	it("each field is independently optional", () => {
		expect(TuningSchema.safeParse({ grounding: "Cite [n]." }).success).toBe(true);
		expect(TuningSchema.safeParse({ decoding: { presence_penalty: 0.5 } }).success).toBe(true);
	});
});

describe("setTuning (writes reject invalid — never silently wipe)", () => {
	// State the premise, don't inherit it. `findOne` is one module-level mock shared by every describe
	// in this file, and the concurrency blocks below set it to a doc carrying `editedAt`. This block
	// needs "no existing row", so it resets `findOne` itself: clearing `updateOne` alone leaves `findOne`
	// however the last test set it, and `setTuning` would read a prior `editedAt` and throw
	// TuningConflictError (the optimistic-concurrency guard working against an unasserted premise).
	// `vitest --sequence.shuffle` exposes the dependence.
	beforeEach(() => {
		updateOne.mockClear();
		findOneMock.mockReset();
		findOneMock.mockResolvedValue(null);
	});

	it("persists a valid doc and stamps editedBy/editedAt", async () => {
		const out = await setTuning(
			{ persona: "Hi {model}.", decoding: { temperature: 0.3 } },
			"editor"
		);
		expect(out.persona).toBe("Hi {model}.");
		expect(out.editedBy).toBe("editor");
		expect(out.editedAt).toBeTruthy();
		expect(updateOne).toHaveBeenCalledOnce();
	});

	it("THROWS on an out-of-range field and does NOT write (no silent wipe)", async () => {
		await expect(setTuning({ decoding: { temperature: 9 } }, "editor")).rejects.toThrow();
		expect(updateOne).not.toHaveBeenCalled();
	});

	it("THROWS on a wrong-typed field rather than dropping all overrides", async () => {
		// @ts-expect-error — deliberately invalid input (simulates a non-form POST)
		await expect(setTuning({ persona: 123 }, "editor")).rejects.toThrow();
		expect(updateOne).not.toHaveBeenCalled();
	});
});

describe("setTuning optimistic concurrency (two editors can't silently clobber)", () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const findOne = vi.mocked((collections as any).config.findOne);
	beforeEach(() => {
		updateOne.mockReset();
		findOne.mockReset();
		findOne.mockResolvedValue(null);
		updateOne.mockResolvedValue({ matchedCount: 1 });
	});

	it("matching token → conditional update on {key, editedAt}, no upsert, lands", async () => {
		const out = await setTuning({ persona: "X" }, "editor", "2026-06-19T10:00:00.000Z");
		expect(out.persona).toBe("X");
		const [filter, , opts] = updateOne.mock.calls[0];
		expect(filter).toMatchObject({ key: "TUNING", editedAt: "2026-06-19T10:00:00.000Z" });
		expect(opts).toMatchObject({ upsert: false });
	});

	it("stale token (matchedCount 0) → TuningConflictError with the current editor/time", async () => {
		updateOne.mockResolvedValue({ matchedCount: 0 });
		findOne.mockResolvedValue({
			key: "TUNING",
			persona: "Y",
			editedBy: "other-editor",
			editedAt: "2026-06-19T11:00:00.000Z",
		});
		await expect(
			setTuning({ persona: "X" }, "editor", "2026-06-19T10:00:00.000Z")
		).rejects.toMatchObject({
			name: "TuningConflictError",
			editedBy: "other-editor",
			editedAt: "2026-06-19T11:00:00.000Z",
		});
	});

	it("no token + no existing row → first-ever save upserts", async () => {
		await setTuning({ persona: "X" }, "editor");
		const [filter, , opts] = updateOne.mock.calls[0];
		expect(filter).toMatchObject({ key: "TUNING" });
		expect(opts).toMatchObject({ upsert: true });
	});

	it("no token but a row appeared since load → TuningConflictError, no write", async () => {
		findOne.mockResolvedValue({
			key: "TUNING",
			editedBy: "other-editor",
			editedAt: "2026-06-19T11:00:00.000Z",
		});
		await expect(setTuning({ persona: "X" }, "editor")).rejects.toBeInstanceOf(TuningConflictError);
		expect(updateOne).not.toHaveBeenCalled();
	});
});

describe("setTuning version-history backup (prior values are recoverable, not clobbered)", () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const findOne = vi.mocked((collections as any).config.findOne);
	beforeEach(() => {
		updateOne.mockReset();
		findOne.mockReset();
		updateOne.mockResolvedValue({ matchedCount: 1 });
	});

	it("snapshots the value it replaces into history, newest-first, without nesting", async () => {
		findOne.mockResolvedValue({
			key: "TUNING",
			persona: "OLD",
			editedBy: "other-editor",
			editedAt: "2026-06-19T10:00:00.000Z",
			history: [{ persona: "OLDER", editedBy: "editor", editedAt: "2026-06-18T00:00:00.000Z" }],
		});
		await setTuning({ persona: "NEW" }, "editor", "2026-06-19T10:00:00.000Z");
		const written = (
			updateOne.mock.calls[0][1] as {
				$set: { persona?: string; history: Array<Record<string, unknown>> };
			}
		).$set;
		expect(written.persona).toBe("NEW");
		expect(written.history[0]).toMatchObject({ persona: "OLD", editedBy: "other-editor" });
		expect(written.history[1]).toMatchObject({ persona: "OLDER" });
		expect(written.history[0].history).toBeUndefined(); // snapshots never nest
	});

	it("does not snapshot when there was no prior save (first ever → empty history)", async () => {
		findOne.mockResolvedValue(null);
		await setTuning({ persona: "FIRST" }, "editor");
		const written = (
			updateOne.mock.calls[0][1] as {
				$set: { persona?: string; history: Array<Record<string, unknown>> };
			}
		).$set;
		expect(written.history).toEqual([]);
	});

	it("clearTuning deletes the TUNING row (reset to code defaults)", async () => {
		deleteOne.mockClear();
		await clearTuning();
		expect(deleteOne).toHaveBeenCalledOnce();
		expect(deleteOne.mock.calls[0][0]).toEqual({ key: "TUNING" });
	});

	it("caps history at 20 entries (oldest drops off)", async () => {
		// A real stored row never exceeds 20 (setTuning caps it). Seed the max, so prepending the
		// just-replaced value pushes to 21 → capped back to 20, dropping the oldest.
		const old = Array.from({ length: 20 }, (_, i) => ({ persona: `v${i}`, editedAt: `t${i}` }));
		findOne.mockResolvedValue({
			key: "TUNING",
			persona: "CURRENT",
			editedAt: "2026-06-19T10:00:00.000Z",
			history: old,
		});
		await setTuning({ persona: "NEW" }, "editor", "2026-06-19T10:00:00.000Z");
		const written = (
			updateOne.mock.calls[0][1] as {
				$set: { persona?: string; history: Array<Record<string, unknown>> };
			}
		).$set;
		expect(written.history).toHaveLength(20);
		expect(written.history[0]).toMatchObject({ persona: "CURRENT" }); // newest = the replaced value
		expect(written.history.at(-1)).toMatchObject({ persona: "v18" }); // oldest (v19) dropped
	});
});
