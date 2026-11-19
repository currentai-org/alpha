/**
 * A turn refused for its sealed history. The server answers a missing or stale posted
 * history with a 409 that carries `reason`; the client must tell it from the duplicate-turn 409 (which
 * attaches to a running turn), reopen the conversation once, and send again with what it reopened.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchMessageUpdates, GenerationConflictError } from "./messageUpdates";
import {
	MessageUpdateStatus,
	MessageUpdateType,
	PRESTREAM_ACCEPTED_PHASE,
} from "$lib/chat/types/MessageUpdate";

vi.mock("$lib/chat/stores/connectionState", () => ({
	noteHeartbeat: vi.fn(),
	noteStreamSettled: vi.fn(),
}));

const ndjson = (...updates: unknown[]) => updates.map((u) => JSON.stringify(u) + "\n").join("");
const accepted = {
	type: MessageUpdateType.Status,
	status: MessageUpdateStatus.KeepAlive,
	message: PRESTREAM_ACCEPTED_PHASE,
};
const finished = { type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished };
const refused = (reason: string) => ({
	type: MessageUpdateType.Status,
	status: MessageUpdateStatus.Error,
	statusCode: 409,
	message: "unlock this chat to continue it: a sealed message was not sent",
	reason,
});

const sent = (init: RequestInit | undefined) =>
	JSON.parse((init?.body as FormData).get("data") as string) as {
		generationId: string;
		history?: { id: string; rev: number }[];
	};

const opts = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, over = {}) => ({
	base: "/chat",
	isRetry: false,
	generationId: "gen-1",
	streamingMode: "raw" as const,
	history: [{ id: "m1", rev: 0, body: { content: "first" } }],
	connectRetryOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, random: () => 0 },
	...over,
});

describe("fetchMessageUpdates on a sealed-history refusal", () => {
	it("reopens once and resends with the reopened history, keeping the generationId", async () => {
		const bodies: ReturnType<typeof sent>[] = [];
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			bodies.push(sent(init));
			return bodies.length === 1
				? new Response(ndjson(refused("history_missing")), { status: 200 })
				: new Response(ndjson(accepted, finished), { status: 200 });
		});
		const resyncSealedHistory = vi.fn(async () => ({
			history: [
				{ id: "m1", rev: 0, body: { content: "first" } },
				{ id: "m2", rev: 1, body: { content: "second" } },
			],
		}));
		const updates = await fetchMessageUpdates(
			"c1",
			opts(fetchImpl, { resyncSealedHistory }),
			new AbortController().signal
		);
		for await (const _ of updates) void _;
		expect(resyncSealedHistory).toHaveBeenCalledTimes(1);
		expect(bodies).toHaveLength(2);
		expect(bodies[1].history?.map((h) => [h.id, h.rev])).toEqual([
			["m1", 0],
			["m2", 1],
		]);
		expect(bodies[1].generationId).toBe(bodies[0].generationId);
	});

	it("surfaces a second refusal instead of looping", async () => {
		const fetchImpl = vi.fn(
			async () => new Response(ndjson(refused("history_mismatch")), { status: 200 })
		);
		const resyncSealedHistory = vi.fn(async () => ({}));
		await expect(
			fetchMessageUpdates("c1", opts(fetchImpl, { resyncSealedHistory }), new AbortController().signal)
		).rejects.toMatchObject({ name: "SealedHistoryRefusedError" });
		expect(resyncSealedHistory).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("never resyncs a refusal reopening cannot fix (history_unexpected)", async () => {
		const fetchImpl = vi.fn(
			async () => new Response(ndjson(refused("history_unexpected")), { status: 200 })
		);
		const resyncSealedHistory = vi.fn(async () => ({}));
		await expect(
			fetchMessageUpdates("c1", opts(fetchImpl, { resyncSealedHistory }), new AbortController().signal)
		).rejects.toMatchObject({ name: "SealedHistoryRefusedError" });
		expect(resyncSealedHistory).not.toHaveBeenCalled();
	});

	it("reads an HTTP 409 with a history reason as a refusal, not a duplicate turn to attach to", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ message: "history refused", reason: "history_missing" }), {
					status: 409,
				})
		);
		const err = await fetchMessageUpdates("c1", opts(fetchImpl), new AbortController().signal).catch(
			(e: unknown) => e
		);
		expect(err).toMatchObject({ name: "SealedHistoryRefusedError", reason: "history_missing" });
		expect(err).not.toBeInstanceOf(GenerationConflictError);
	});

	it("still reads a 409 without a history reason as the duplicate-turn conflict", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					ndjson({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						statusCode: 409,
						message: "generation already in_flight",
						conflict: { status: "in_flight", conversationId: "c1", messageId: "a1" },
					}),
					{ status: 200 }
				)
		);
		await expect(
			fetchMessageUpdates("c1", opts(fetchImpl), new AbortController().signal)
		).rejects.toBeInstanceOf(GenerationConflictError);
	});
});
