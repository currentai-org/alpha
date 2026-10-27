/**
 * Only a failed read of the answer's body counts as a dropped connection.
 *
 * The conversation page shows "connection dropped" only when `isLateConnectionLoss` says so, so the
 * contract is which errors it accepts: a body that errors mid-answer does, and a TypeError thrown
 * by the code consuming the updates (a bug in our page) does not. (CUR-2912)
 */
import { describe, expect, it, vi } from "vitest";
import { fetchMessageUpdates, isLateConnectionLoss } from "./messageUpdates";
import {
	MessageUpdateStatus,
	MessageUpdateType,
	PRESTREAM_ACCEPTED_PHASE,
	type MessageUpdate,
} from "$lib/chat/types/MessageUpdate";

vi.mock("$lib/chat/stores/connectionState", () => ({
	noteHeartbeat: vi.fn(),
	noteStreamSettled: vi.fn(),
}));

const line = (u: unknown) => new TextEncoder().encode(JSON.stringify(u) + "\n");
const accepted = {
	type: MessageUpdateType.Status,
	status: MessageUpdateStatus.KeepAlive,
	message: PRESTREAM_ACCEPTED_PHASE,
};
const token = { type: MessageUpdateType.Stream, token: "Hello" };

/** A 200 whose body sends the accepted marker and one token, then fails the way a dropped line does. */
const bodyThatDropsAfterFirstToken = () => {
	let sent = false;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!sent) {
					sent = true;
					controller.enqueue(line(accepted));
					controller.enqueue(line(token));
					return;
				}
				controller.error(new TypeError("network error"));
			},
		}),
		{ status: 200 }
	);
};

const open = (response: () => Response) =>
	fetchMessageUpdates(
		"c1",
		{
			base: "/chat",
			isRetry: false,
			generationId: "gen-1",
			streamingMode: "raw",
			connectRetryOptions: { fetchImpl: async () => response(), sleep: async () => {}, random: () => 0 },
		} as Parameters<typeof fetchMessageUpdates>[1],
		new AbortController().signal
	);

describe("a mid-answer failure is a dropped connection only when the read failed (CUR-2912)", () => {
	it("counts a body that errors after the first token as a lost connection, still a TypeError", async () => {
		const seen: MessageUpdate[] = [];
		const err = await (async () => {
			try {
				for await (const u of await open(bodyThatDropsAfterFirstToken)) seen.push(u);
			} catch (e) {
				return e;
			}
		})();
		expect(seen.some((u) => u.type === MessageUpdateType.Stream)).toBe(true);
		expect(isLateConnectionLoss(err)).toBe(true);
		expect(err).toBeInstanceOf(TypeError);
		expect((err as Error).message).toBe("network error");
	});

	it("does not count a TypeError the consumer throws while the body is healthy as a lost connection", async () => {
		const err = await (async () => {
			try {
				for await (const u of await open(() => new Response(new Blob([line(accepted), line(token)]))))
					if (u.type === MessageUpdateType.Stream) (undefined as unknown as () => void)();
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(TypeError);
		expect(isLateConnectionLoss(err)).toBe(false);
	});
});
