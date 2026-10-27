import { describe, it, expect, vi, afterEach } from "vitest";
import { sanitizeCorrection, correctEntityQuery } from "./entityCorrection";

vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

// The timeout cases pass this in place of the 5s production budget (entityCorrection.ts:32).
const BUDGET_MS = 300;

describe("sanitizeCorrection", () => {
	const original = "who is goad pistilli";

	it("treats NONE (any case) as nothing to correct", () => {
		expect(sanitizeCorrection("NONE", original)).toBeUndefined();
		expect(sanitizeCorrection("none", original)).toBeUndefined();
		expect(sanitizeCorrection("  None  ", original)).toBeUndefined();
	});

	it("falls back to undefined on empty or over-long output", () => {
		expect(sanitizeCorrection("", original)).toBeUndefined();
		expect(sanitizeCorrection("   ", original)).toBeUndefined();
		expect(sanitizeCorrection("x".repeat(250), original)).toBeUndefined();
	});

	it("strips surrounding quotes and keeps only the first line", () => {
		expect(sanitizeCorrection('"who is giada pistilli"', original)).toBe("who is giada pistilli");
		expect(
			sanitizeCorrection("who is giada pistilli\nCorrected the surname spelling.", original)
		).toBe("who is giada pistilli");
	});

	it("returns undefined when the model just echoes the query back — no name to fix means no second dispatch", () => {
		expect(sanitizeCorrection(original, original)).toBeUndefined();
		expect(sanitizeCorrection("WHO IS GOAD PISTILLI", original)).toBeUndefined();
	});

	it("passes a real correction through unchanged", () => {
		expect(sanitizeCorrection("who is giada pistilli", original)).toBe("who is giada pistilli");
	});
});

describe("correctEntityQuery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("$lib/chat/server/generateFromDefaultEndpoint");
		// The logger mock is a single shared vi.fn() from the top-level vi.mock factory, not a per-test
		// spy — restoreAllMocks doesn't touch its call history, so an earlier test's calls leak into a
		// later toHaveBeenCalled()/not.toHaveBeenCalled() assertion unless cleared explicitly.
		vi.clearAllMocks();
	});

	it("returns undefined for a blank query without calling the model", async () => {
		const spy = vi.fn();
		vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
			generateFromDefaultEndpoint: spy,
		}));
		expect(await correctEntityQuery("   ", undefined)).toBeUndefined();
		expect(spy).not.toHaveBeenCalled();
	});

	it("returns the sanitized correction on a real model answer", async () => {
		vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
			// eslint-disable-next-line require-yield -- stubs the generator's RETURN value; no streamed tokens needed
			generateFromDefaultEndpoint: async function* () {
				return "who is giada pistilli";
			},
		}));
		const out = await correctEntityQuery("who is goad pistilli", undefined);
		expect(out).toBe("who is giada pistilli");
	});

	it("logs the success case by LENGTH only, never the raw query text (CUR-914 house rule)", async () => {
		const { logger } = await import("$lib/chat/server/logger");
		vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
			// eslint-disable-next-line require-yield -- stubs the generator's RETURN value; no streamed tokens needed
			generateFromDefaultEndpoint: async function* () {
				return "who is giada pistilli";
			},
		}));
		await correctEntityQuery("who is goad pistilli", undefined);
		expect(logger.info).toHaveBeenCalledWith(
			{ originalLength: "who is goad pistilli".length, correctedLength: "who is giada pistilli".length },
			expect.stringContaining("entity-name correction found")
		);
		expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("goad pistilli");
	});

	it("a NONE verdict logs no success line but does log its own outcome, so the timeout share has a denominator (CUR-2140)", async () => {
		const { logger } = await import("$lib/chat/server/logger");
		vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
			// eslint-disable-next-line require-yield -- stubs the generator's RETURN value; no streamed tokens needed
			generateFromDefaultEndpoint: async function* () {
				return "NONE";
			},
		}));
		await correctEntityQuery("who is goad pistilli", undefined);
		const messages = vi.mocked(logger.info).mock.calls.map((c) => c[1]);
		expect(messages).not.toContainEqual(expect.stringContaining("entity-name correction found"));
		expect(await outcomeLine()).toMatchObject({ outcome: "none", caller: "search" });
	});

	it("fails open (undefined) when the model call throws", async () => {
		vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
			// eslint-disable-next-line require-yield -- deliberately throws before any yield, to prove the catch fires
			generateFromDefaultEndpoint: async function* () {
				throw new Error("endpoint unavailable");
			},
		}));
		expect(await correctEntityQuery("who is goad pistilli", undefined)).toBeUndefined();
	});

	it(
		"CLOSES the abandoned generation when the timer wins, rather than leaving it draining (CUR-1655)",
		async () => {
			// The contract this pins is not "the caller returns undefined" — the test below already
			// passes on that with the generation still running. It is that the losing generation gets
			// closed, which is the part that decides whether the turn survives: an abandoned drain keeps
			// the upstream async iterator from ever returning `done`, and screenStream's consumer then
			// parks forever waiting for a producer that never finishes (CUR-1657).
			let unwound = false;
			vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
				generateFromDefaultEndpoint: async function* () {
					try {
						for (;;) {
							// A lane that keeps producing forever, each pull well inside the budget — so a
							// drain nobody closes would go on indefinitely rather than ending on its own.
							await new Promise((r) => setTimeout(r, 50));
							yield { type: "stream", token: "x" };
						}
					} finally {
						unwound = true;
					}
				},
			}));
			await expect(
				correctEntityQuery("who is goad pistilli", undefined, "search", BUDGET_MS)
			).resolves.toBeUndefined();
			// return() queues behind the in-flight pull, so give it a few pulls to land on.
			await new Promise((r) => setTimeout(r, 200));
			expect(
				unwound,
				"the losing generation was never closed — it is still draining and still holding the upstream stream open"
			).toBe(true);
		}
	);

	it(
		"times out rather than hanging forever — generateFromDefaultEndpoint takes no AbortSignal",
		async () => {
			vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
				// eslint-disable-next-line require-yield -- deliberately never settles, to prove the race fires
				generateFromDefaultEndpoint: async function* () {
					await new Promise(() => {}); // never resolves
					return "unreachable";
				},
			}));
			// Real timers, not faked: a fake-timer clock doesn't reliably interleave with the real
			// microtask chain the dynamic import + async generator go through here. A short budget keeps
			// the real wait small instead.
			await expect(
				correctEntityQuery("who is goad pistilli", undefined, "search", BUDGET_MS)
			).resolves.toBeUndefined();
		}
	);
});

/** The one per-call line CUR-2140 adds; undefined if the call wrote none. */
async function outcomeLine(): Promise<Record<string, unknown> | undefined> {
	const { logger } = await import("$lib/chat/server/logger");
	const calls = vi
		.mocked(logger.info)
		.mock.calls.filter((c) => c[1] === "[search] entity-name correction outcome");
	expect(calls.length, "exactly one outcome line per call").toBeLessThanOrEqual(1);
	return calls[0]?.[0] as Record<string, unknown> | undefined;
}

describe("correctEntityQuery — one outcome line on every call (CUR-2140)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("$lib/chat/server/generateFromDefaultEndpoint");
		vi.clearAllMocks();
	});

	it("a found correction logs its caller, total time, first-token time and the backend that served it", async () => {
		vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
			generateFromDefaultEndpoint: async function* (opts: {
				onServed?: (s: { backend?: string; model?: string }) => void;
			}) {
				yield { type: "stream", token: "who is giada" };
				opts.onServed?.({ backend: "https://api.example-lane.test/v1", model: "lane-model" });
				return "who is giada pistilli";
			},
		}));
		await correctEntityQuery("who is goad pistilli", undefined, "title");
		const line = await outcomeLine();
		expect(line).toMatchObject({
			leg: "entity-correction",
			caller: "title",
			outcome: "found",
			backend: "https://api.example-lane.test/v1",
			servedModel: "lane-model",
			queryLength: "who is goad pistilli".length,
		});
		expect(typeof line?.ms).toBe("number");
		expect(typeof line?.firstTokenMs).toBe("number");
		expect(JSON.stringify(line)).not.toContain("goad");
	});

	it("an echo of the query logs as unusable, not as none", async () => {
		vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
			// eslint-disable-next-line require-yield -- stubs the generator's RETURN value
			generateFromDefaultEndpoint: async function* () {
				return "who is goad pistilli";
			},
		}));
		await correctEntityQuery("who is goad pistilli", undefined);
		expect(await outcomeLine()).toMatchObject({ outcome: "unusable" });
	});

	it("an empty reply the endpoint flagged as failed logs as error, not as a model that said nothing", async () => {
		vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
			// eslint-disable-next-line require-yield -- stubs the generator's RETURN value
			generateFromDefaultEndpoint: async function* (opts: { onFailure?: (k: "error") => void }) {
				opts.onFailure?.("error");
				return "";
			},
		}));
		await correctEntityQuery("who is goad pistilli", undefined);
		expect(await outcomeLine()).toMatchObject({ outcome: "error" });
	});

	it("a thrown call logs as error", async () => {
		vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
			// eslint-disable-next-line require-yield -- throws before any yield
			generateFromDefaultEndpoint: async function* () {
				throw new Error("endpoint unavailable");
			},
		}));
		await correctEntityQuery("who is goad pistilli", undefined);
		expect(await outcomeLine()).toMatchObject({ outcome: "error" });
	});

	it(
		"a call the abort signal cuts first still logs as timeout, with no first-token time when nothing streamed",
		async () => {
			// generateFromDefaultEndpoint's real behaviour on its caller's signal: swallow the abort and
			// return "". It can win the race, so the timeout must still be logged rather than read as silence (CUR-2140).
			vi.doMock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
				// eslint-disable-next-line require-yield -- stalls until aborted, then returns the stand-in
				generateFromDefaultEndpoint: async function* (opts: { signal?: AbortSignal }) {
					await new Promise<void>((resolve) => opts.signal && (opts.signal.onabort = () => resolve()));
					return "";
				},
			}));
			await correctEntityQuery("who is goad pistilli", undefined, "search", BUDGET_MS);
			const line = await outcomeLine();
			expect(line).toMatchObject({ outcome: "timeout", caller: "search", timeoutMs: BUDGET_MS });
			expect(line?.firstTokenMs).toBeUndefined();
			expect(line?.ms as number).toBeGreaterThanOrEqual(BUDGET_MS - 10);
		}
	);
});
