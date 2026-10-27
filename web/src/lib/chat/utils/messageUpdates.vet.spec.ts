/**
 * Prestream-events protocol: fetchMessageUpdates vetting + vet-level retry.
 *
 * The contract under test (see the server's runPrestream + prestreamFailureUpdate):
 *   - the request opts in via the `x-prestream-events: 1` header
 *   - `phase:starting` keepalives are buffered during vet and REPLAYED to the consumer
 *   - the accepted marker ends the vet and is swallowed (protocol, not content)
 *   - an OLD server's first real event accepts the vet too (its failures are HTTP statuses)
 *   - event-coded failures throw the SAME typed errors their HTTP statuses used to:
 *       409 → GenerationConflictError (with the conflict payload)
 *       429 → GenerationRequestError carrying the verbatim rate-limit message
 *   - stream-sourced ≥500s retry with a FRESH generationId (dead claim), bounded;
 *     HTTP-sourced ≥500s do NOT re-enter the vet-level retry (they already spent
 *     connectWithRetry's budget)
 *   - EOF before any verdict = a killed invocation → 502, retryable
 *   - a caller abort mid-vet surfaces as AbortError, never as a retry or a 502
 *
 * Determinism: injected fetch (NDJSON Response bodies), no-op sleep, pinned RNG.
 */
import { describe, expect, it, vi } from "vitest";
import {
	fetchMessageUpdates,
	GenerationConflictError,
	GenerationRequestError,
} from "./messageUpdates";
import { noteStreamSettled } from "$lib/chat/stores/connectionState";

// Spy on the connection-state store: the vet must run the stream generator's finally (which calls
// noteStreamSettled) before throwing an event-coded failure, or the store thinks a stream is still
// live and the "reconnecting…" banner heuristics go stale.
vi.mock("$lib/chat/stores/connectionState", () => ({
	noteHeartbeat: vi.fn(),
	noteStreamSettled: vi.fn(),
}));
import {
	MessageUpdateStatus,
	MessageUpdateType,
	PRESTREAM_ACCEPTED_PHASE,
	PRESTREAM_EVENTS_HEADER,
	PRESTREAM_STARTING_PHASE,
	type MessageUpdate,
} from "$lib/chat/types/MessageUpdate";

const ndjson = (...updates: unknown[]) => updates.map((u) => JSON.stringify(u) + "\n").join("");

const starting = {
	type: MessageUpdateType.Status,
	status: MessageUpdateStatus.KeepAlive,
	message: PRESTREAM_STARTING_PHASE,
};
const accepted = {
	type: MessageUpdateType.Status,
	status: MessageUpdateStatus.KeepAlive,
	message: PRESTREAM_ACCEPTED_PHASE,
};
const token = { type: MessageUpdateType.Stream, token: "Hello" };
const finished = { type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished };

const baseOpts = (over: Record<string, unknown> = {}) => ({
	base: "/chat",
	isRetry: false,
	generationId: "gen-1",
	streamingMode: "raw" as const,
	connectRetryOptions: { sleep: async () => {}, random: () => 0 },
	...over,
});

const collect = async (it: AsyncGenerator<MessageUpdate>) => {
	const out: MessageUpdate[] = [];
	for await (const u of it) out.push(u);
	return out;
};

/** The generationId a given fetch call's multipart body carried. */
const sentGenerationId = (init: RequestInit | undefined): string => {
	const data = (init?.body as FormData).get("data") as string;
	return JSON.parse(data).generationId;
};

describe("fetchMessageUpdates prestream vetting", () => {
	it("opts in via the prestream-events header", async () => {
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			expect(new Headers(init?.headers).get(PRESTREAM_EVENTS_HEADER)).toBe("1");
			return new Response(ndjson(accepted, token, finished), { status: 200 });
		});
		await fetchMessageUpdates(
			"c1",
			baseOpts({ connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0 } }),
			new AbortController().signal
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("buffers starting keepalives, swallows the accepted marker, replays the rest in order", async () => {
		const fetchImpl = async () =>
			new Response(ndjson(starting, starting, accepted, token, finished), { status: 200 });
		const events: string[] = [];
		const it = await fetchMessageUpdates(
			"c1",
			baseOpts({
				onPrestreamEvent: () => events.push("vetted"),
				connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0 },
			}),
			new AbortController().signal
		);
		const out = await collect(it);
		// The two starting keepalives replay (the page's phase indicator behaves as today); the
		// accepted marker never surfaces.
		expect(out.map((u) => ("message" in u ? u.message : u.type))).toEqual([
			PRESTREAM_STARTING_PHASE,
			PRESTREAM_STARTING_PHASE,
			"stream",
			"status",
		]);
		// onPrestreamEvent fired for each event consumed during vet (2 starting + accepted).
		expect(events).toHaveLength(3);
	});

	it("accepts on an OLD server's first real event and replays it (deploy skew)", async () => {
		// An old server emits its own post-chain `phase:starting` then real updates — no accepted
		// marker ever. The first non-starting event must end the vet, not hang it.
		const fetchImpl = async () => new Response(ndjson(starting, token, finished), { status: 200 });
		const it = await fetchMessageUpdates(
			"c1",
			baseOpts({ connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0 } }),
			new AbortController().signal
		);
		const out = await collect(it);
		expect(out[1]).toMatchObject({ type: MessageUpdateType.Stream, token: "Hello" });
	});

	it("translates an event-coded 409 into GenerationConflictError with the conflict payload", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					ndjson(starting, {
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						statusCode: 409,
						message: "generation already in_flight",
						conflict: { status: "in_flight", conversationId: "c1", messageId: "m7" },
					}),
					{ status: 200 }
				)
		);
		const err = await fetchMessageUpdates(
			"c1",
			baseOpts({ connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0 } }),
			new AbortController().signal
		).catch((e) => e);
		expect(err).toBeInstanceOf(GenerationConflictError);
		expect(err.status).toBe("in_flight");
		expect(err.messageId).toBe("m7");
		expect(fetchImpl).toHaveBeenCalledTimes(1); // conflicts never retry
		// The stream generator was settled (its finally ran) before the vet threw — the connection
		// store must not be left thinking a stream is live.
		expect(vi.mocked(noteStreamSettled)).toHaveBeenCalled();
	});

	it("translates an event-coded 429 into GenerationRequestError with the verbatim message", async () => {
		const rateLimitMsg = "You are sending too many messages. Try again later.";
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					ndjson(starting, {
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						statusCode: 429,
						message: rateLimitMsg,
					}),
					{ status: 200 }
				)
		);
		const err = await fetchMessageUpdates(
			"c1",
			baseOpts({ connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0 } }),
			new AbortController().signal
		).catch((e) => e);
		expect(err).toBeInstanceOf(GenerationRequestError);
		expect(err.status).toBe(429);
		// The composer-restore path matches on this exact message (isRateLimitMessage) — it must
		// flow through verbatim.
		expect(err.message).toBe(rateLimitMsg);
		expect(fetchImpl).toHaveBeenCalledTimes(1); // 4xx never retries
	});

	it("retries an event-coded 500 with a FRESH generationId, then succeeds", async () => {
		let call = 0;
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			if (call++ === 0) {
				expect(sentGenerationId(init)).toBe("gen-1");
				return new Response(
					ndjson(starting, {
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						statusCode: 500,
						message: "Internal Error",
					}),
					{ status: 200 }
				);
			}
			// The dead claim's id must NOT be reused — the retry minted a fresh one.
			expect(sentGenerationId(init)).toBe("gen-2");
			return new Response(ndjson(accepted, token, finished), { status: 200 });
		});
		const advanceGenerationId = vi.fn(() => "gen-2");
		const it = await fetchMessageUpdates(
			"c1",
			baseOpts({
				advanceGenerationId,
				connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0 },
			}),
			new AbortController().signal
		);
		const out = await collect(it);
		expect(out.at(0)).toMatchObject({ token: "Hello" });
		expect(advanceGenerationId).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("throws once event-coded 500s exhaust the vet attempts", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					ndjson({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						statusCode: 500,
						message: "Internal Error",
					}),
					{ status: 200 }
				)
		);
		const err = await fetchMessageUpdates(
			"c1",
			baseOpts({ connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0 } }),
			new AbortController().signal
		).catch((e) => e);
		expect(err).toBeInstanceOf(GenerationRequestError);
		expect(err.status).toBe(500);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	// The admission-gate capacity shed: the server emits a pre-accept 503 event, which must ride the
	// same >=500 vet retry as a 500 and, on exhaustion, surface as GenerationRequestError(503) carrying
	// the capacity copy. handleFetchError keys on exactly this (status===503) to show the calm "busy"
	// message instead of "connection lost".
	it("retries an event-coded 503 capacity shed, then surfaces it as 503 on exhaustion", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					ndjson({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						statusCode: 503,
						message: "Alpha is at capacity right now. Please try again in a moment.",
					}),
					{ status: 200 }
				)
		);
		const err = await fetchMessageUpdates(
			"c1",
			baseOpts({ connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0 } }),
			new AbortController().signal
		).catch((e) => e);
		expect(err).toBeInstanceOf(GenerationRequestError);
		expect(err.status).toBe(503);
		expect(err.message).toContain("at capacity");
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("treats EOF before any verdict as a killed invocation: 502, retried", async () => {
		let call = 0;
		const fetchImpl = vi.fn(async () => {
			if (call++ === 0) return new Response("", { status: 200 }); // died between headers and chain
			return new Response(ndjson(accepted, token, finished), { status: 200 });
		});
		const it = await fetchMessageUpdates(
			"c1",
			baseOpts({ connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0 } }),
			new AbortController().signal
		);
		const out = await collect(it);
		expect(out.at(0)).toMatchObject({ token: "Hello" });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("does NOT vet-retry an HTTP-sourced 5xx (connectWithRetry already spent its budget)", async () => {
		const fetchImpl = vi.fn(async () => new Response("cold", { status: 503 }));
		const err = await fetchMessageUpdates(
			"c1",
			baseOpts({
				connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0, attempts: 2 },
			}),
			new AbortController().signal
		).catch((e) => e);
		expect(err).toBeInstanceOf(GenerationRequestError);
		expect(err.status).toBe(503);
		expect(err.source).toBe("http");
		// 2 = connectWithRetry's own budget, once. A vet-level retry would have doubled it.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("still translates an HTTP 409 from an OLD server (pre-events protocol) into the conflict error", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ status: "complete", conversationId: "c1", messageId: "m9" }), {
					status: 409,
				})
		);
		const err = await fetchMessageUpdates(
			"c1",
			baseOpts({ connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0 } }),
			new AbortController().signal
		).catch((e) => e);
		expect(err).toBeInstanceOf(GenerationConflictError);
		expect(err.status).toBe("complete");
		expect(err.messageId).toBe("m9");
	});

	it("surfaces a caller abort mid-vet as AbortError — never a retry, never a 502", async () => {
		const ctrl = new AbortController();
		// A stream that emits the starting keepalive then stays open (chain still "running").
		const encoder = new TextEncoder();
		const body = new ReadableStream({
			start(c) {
				c.enqueue(encoder.encode(ndjson(starting)));
				// never closes on its own
			},
		});
		const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
		const pending = fetchMessageUpdates(
			"c1",
			baseOpts({
				// Abort (user Stop / watchdog) once the first prestream event has been consumed.
				onPrestreamEvent: () => ctrl.abort(),
				connectRetryOptions: { fetchImpl, sleep: async () => {}, random: () => 0 },
			}),
			ctrl.signal
		);
		const err = await pending.catch((e) => e);
		expect(err).toBeInstanceOf(DOMException);
		expect((err as DOMException).name).toBe("AbortError");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
