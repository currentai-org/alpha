import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The flag plane, controllable. Default implementation is the real contract for an unpolled PostHog —
// call the caller's fallback — matching flagEnabledOr's own default-OFF-until-configured shape.
const flagEnabledOr = vi.fn((_key: string, fallback: () => boolean) => fallback());
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (k: string, f: () => boolean) => flagEnabledOr(k, f),
}));

// Full-replacement mock, required not optional: textGeneration/index.ts boots the model catalog at
// import time outside CI's hermetic mode (models.ts; groundedBailRegen imports from the same module).
const textGenerationWithoutTitle = vi.fn();
vi.mock("./index", () => ({
	textGenerationWithoutTitle: (...args: unknown[]) => textGenerationWithoutTitle(...args),
}));

import { logger } from "$lib/chat/server/logger";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import {
	GROUNDED_BAIL_REGEN_FLAG,
	groundedBailRegenEnabled,
	runGroundedBailRegen,
} from "./groundedBailRegen";
import type { TextGenerationContext } from "./types";

async function* src(events: MessageUpdate[]): AsyncGenerator<MessageUpdate> {
	for (const e of events) yield e;
}
// Never resolves within the test — for the abort/timeout paths, where the caller must give up rather
// than wait on a generator that legitimately hasn't finished.
async function* hangs(): AsyncGenerator<MessageUpdate> {
	yield { type: MessageUpdateType.Status, status: "keepAlive" as never };
	await new Promise(() => {});
	// unreachable, satisfies the generator's yield type
	yield { type: MessageUpdateType.Status, status: "keepAlive" as never };
}

const ctx = {
	searchContext: { evidence: "retrieved evidence", asOf: "2026-08-19" },
	ragContext: { evidence: "rag evidence" },
	speakMode: "always",
	speakAll: true,
	timings: { totalMs: 1 },
} as unknown as TextGenerationContext;

beforeEach(() => {
	flagEnabledOr.mockClear();
	textGenerationWithoutTitle.mockReset();
	vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("groundedBailRegenEnabled", () => {
	it("reads the grounded-bail-regen flag, defaulting to off", () => {
		expect(groundedBailRegenEnabled()).toBe(false);
		expect(flagEnabledOr).toHaveBeenCalledWith(GROUNDED_BAIL_REGEN_FLAG, expect.any(Function));
	});
});

describe("runGroundedBailRegen", () => {
	it("returns the FinalAnswer text on success, and strips grounding from the cloned ctx", async () => {
		textGenerationWithoutTitle.mockImplementation(() =>
			src([{ type: MessageUpdateType.FinalAnswer, text: "Apertus 1.5, made by SNAI.", interrupted: false }])
		);
		const result = await runGroundedBailRegen(ctx, new AbortController().signal);
		expect(result).toBe("Apertus 1.5, made by SNAI.");

		const [passedCtx] = textGenerationWithoutTitle.mock.calls[0] as [TextGenerationContext];
		// Clearing these two is what makes textGeneration/index.ts's own `grounded` derivation false
		// (index.ts: !!(ctx.searchContext?.evidence || rag?.evidence || rag?.vaultSynthesis)) — the whole
		// mechanism this module relies on, so pin it directly rather than trust it by construction.
		expect(passedCtx.searchContext).toBeUndefined();
		expect(passedCtx.ragContext).toBeNull();
		// Never surfaced as a separate playable clip — forced off regardless of the original turn's speak
		// preference.
		expect(passedCtx.speakMode).toBe("off");
		expect(passedCtx.speakAll).toBe(false);
		// A separate generation, not folded into the original turn's phase timings.
		expect(passedCtx.timings).toBeUndefined();
	});

	it("returns undefined when the generator ends without a FinalAnswer", async () => {
		textGenerationWithoutTitle.mockImplementation(() =>
			src([{ type: MessageUpdateType.Status, status: "keepAlive" as never }])
		);
		expect(await runGroundedBailRegen(ctx, new AbortController().signal)).toBeUndefined();
	});

	it("returns undefined and logs a warning when the generator throws", async () => {
		textGenerationWithoutTitle.mockImplementation(() => {
			throw new Error("endpoint unreachable");
		});
		expect(await runGroundedBailRegen(ctx, new AbortController().signal)).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error) }),
			expect.stringContaining("[groundedBailRegen]")
		);
	});

	it("returns undefined immediately, without ever calling the generator, when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await runGroundedBailRegen(ctx, controller.signal)).toBeUndefined();
		expect(textGenerationWithoutTitle).not.toHaveBeenCalled();
	});

	it("returns undefined when the caller's signal aborts mid-regen — never waits out a disconnected client", async () => {
		textGenerationWithoutTitle.mockImplementation(() => hangs());
		const controller = new AbortController();
		const promise = runGroundedBailRegen(ctx, controller.signal);
		controller.abort();
		expect(await promise).toBeUndefined();
	});

	it("times out rather than inheriting the original turn's near-expired budget", async () => {
		vi.useFakeTimers();
		textGenerationWithoutTitle.mockImplementation(() => hangs());
		const promise = runGroundedBailRegen(ctx, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(await promise).toBeUndefined();
	});
});
