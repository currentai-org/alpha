// The reader half of stream-follow. Builds the NDJSON body of
// GET /chat/conversation/[id]/generation/[generationId]: replay every logged batch after `after`,
// then keep polling the log until the answer ends, the producer goes quiet, or the lifetime is up.
//
// A follower is a reader only. It registers nothing in AbortRegistry and writes no stop marker, so
// closing it (cancel) only ends its own loop: the turn goes on, and only the Stop button stops it.
//
// Dependencies come in as functions so the loop is tested without a database or a clock.
import { MessageUpdateStatus, MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import type { MessageUpdate } from "$lib/chat/types/MessageUpdate";
import { GENERATION_STALE_MS, PLATFORM_MAX_DURATION_MS } from "$lib/chat/utils/deadlineLadder";

/** How often the log is read while nothing new has arrived. */
const FOLLOW_POLL_MS = 400;
/** A follow ends well before the platform kill, like the updates stream (60 s of margin). */
const FOLLOW_MAX_LIFETIME_MS = PLATFORM_MAX_DURATION_MS - 60_000;

export type FollowDeps = {
	/** Batches of the log after `afterSeq`, in order. */
	readEvents: (afterSeq: number) => Promise<Array<{ seq: number; payload: string }>>;
	/** Whether the generation has ended (`complete` or `error`). */
	isTerminal: () => Promise<boolean>;
	/** The FinalAnswer the saved message carries, or undefined. Wins over the logged one: a stop
	 *  clamps the saved answer after the log was written. */
	savedFinalAnswer: () => Promise<MessageUpdate | undefined>;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	pollMs?: number;
	maxLifetimeMs?: number;
	staleMs?: number;
	/** How long a logged FinalAnswer waits for the generation to be terminal before it is sent as logged. */
	finalWaitMs?: number;
};

/** The producer logs the FinalAnswer before the clamped save lands and the generation turns terminal. A
 *  follower that read it sooner would show the unclamped text after a Stop, so it waits for terminal. */
const FINAL_WAIT_MS = 15_000;

const KEEP_ALIVE = JSON.stringify({
	type: MessageUpdateType.Status,
	status: MessageUpdateStatus.KeepAlive,
});
/** The turn stream pads after FinalAnswer so an intermediary flushes it; the follow does the same. */
const FINAL_PADDING = " ".repeat(4096);

export function createFollowStream(
	deps: FollowDeps,
	opts: { after?: number } = {}
): ReadableStream<Uint8Array> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const pollMs = deps.pollMs ?? FOLLOW_POLL_MS;
	const maxLifetimeMs = deps.maxLifetimeMs ?? FOLLOW_MAX_LIFETIME_MS;
	const staleMs = deps.staleMs ?? GENERATION_STALE_MS;
	const finalWaitMs = deps.finalWaitMs ?? FINAL_WAIT_MS;
	const encoder = new TextEncoder();
	let cancelled = false;

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (text: string) => {
				if (!cancelled) controller.enqueue(encoder.encode(text));
			};
			const deadline = now() + maxLifetimeMs;
			let after = opts.after ?? -1;
			let lastProgress = now();

			/** Sends the saved FinalAnswer if there is one, else the logged one. True when sent. */
			const sendFinal = async (logged?: string, awaitTerminal = false) => {
				if (awaitTerminal) {
					const until = now() + finalWaitMs;
					while (!cancelled && now() < until && !(await deps.isTerminal().catch(() => true))) {
						send(KEEP_ALIVE + "\n");
						await sleep(pollMs);
					}
				}
				const saved = await deps.savedFinalAnswer().catch(() => undefined);
				if (saved) send(JSON.stringify(saved) + "\n");
				else if (logged !== undefined) send(logged + "\n");
				else return false;
				send(FINAL_PADDING);
				return true;
			};

			/** Replays what the log holds after `after`. True when the answer ended in it. */
			const drain = async () => {
				const rows = await deps.readEvents(after);
				for (const row of rows) {
					after = row.seq;
					lastProgress = now();
					for (const line of row.payload.split("\n")) {
						if (!line) continue;
						let type: unknown;
						try {
							type = (JSON.parse(line) as { type?: unknown }).type;
						} catch {
							continue;
						}
						if (type === MessageUpdateType.FinalAnswer) {
							await sendFinal(line, true);
							return true;
						}
						send(line + "\n");
					}
				}
				return false;
			};

			try {
				while (!cancelled && now() < deadline) {
					if (await drain()) break;
					if (await deps.isTerminal()) {
						// The producer closes the log before it marks the generation terminal, so one more
						// read sees every batch. A turn that ended without a logged FinalAnswer still has a
						// saved one (or none, and the client reloads the saved copy).
						if (!(await drain())) await sendFinal();
						break;
					}
					if (now() - lastProgress > staleMs) break;
					send(KEEP_ALIVE + "\n");
					await sleep(pollMs);
				}
			} catch {
				// A read failed: end the stream. The client falls back to the saved copy.
			}
			if (!cancelled) {
				try {
					controller.close();
				} catch {
					// already closed by a cancel racing the loop
				}
			}
		},
		cancel() {
			cancelled = true;
		},
	});
}
