// The producer half of stream-follow. Records what the turn's stream sent the client, in
// order, into Postgres (`generation_events`), so a client whose connection dropped can replay it and
// keep following (routes/chat/conversation/[id]/generation/[generationId]).
//
// Lines are buffered and written as one INSERT per FLUSH_MS, on a chain of their own: it never queues
// behind the conversation's whole-document writes. A failed write is logged and dropped, because the
// log is a convenience for a dropped client and the turn itself must never fail on it; the follow
// route ends at the terminal row/status either way, and the saved copy stays the fallback.
import { logger } from "$lib/chat/server/logger";
import {
	deleteGenerationEvents,
	insertGenerationEvents,
} from "$lib/chat/server/db/generationEvents";

/** How often buffered lines are written. About two small INSERTs a second while a turn streams. */
const GENERATION_LOG_FLUSH_MS = 500;
/** How long a finished turn's rows stay, so a follower still catching up finds them. */
const GENERATION_LOG_GRACE_MS = 120_000;

export type GenerationLogStore = {
	insert: (generationId: string, conversationId: string, seq: number, payload: string) => Promise<void>;
	remove: (generationId: string) => Promise<unknown>;
};

const dbStore: GenerationLogStore = {
	insert: insertGenerationEvents,
	remove: deleteGenerationEvents,
};

export type GenerationLogWriter = {
	/** Buffer one line (a JSON object, no trailing newline). Never throws. */
	append: (line: string) => void;
	/** Start writing what is buffered now, without waiting. Used when a line ends the answer. */
	flush: () => void;
	/** Write what is buffered and wait for every write in flight. Never rejects. */
	close: () => Promise<void>;
	/** Delete this generation's rows `GENERATION_LOG_GRACE_MS` from now. Never rejects. */
	scheduleDelete: (run: (work: Promise<unknown>) => void) => void;
};

export function createGenerationLogWriter(
	generationId: string,
	conversationId: string,
	opts: { store?: GenerationLogStore; flushMs?: number; graceMs?: number } = {}
): GenerationLogWriter {
	const store = opts.store ?? dbStore;
	const flushMs = opts.flushMs ?? GENERATION_LOG_FLUSH_MS;
	const graceMs = opts.graceMs ?? GENERATION_LOG_GRACE_MS;
	let buffer: string[] = [];
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let chain: Promise<void> = Promise.resolve();

	const flush = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (buffer.length === 0) return;
		const payload = buffer.join("\n");
		buffer = [];
		const mySeq = seq++;
		chain = chain.then(() =>
			store.insert(generationId, conversationId, mySeq, payload).catch((err) => {
				logger.warn({ err, generationId, seq: mySeq }, "[stream-follow] could not write a log batch");
			})
		);
	};

	return {
		flush,
		append(line) {
			buffer.push(line);
			if (!timer) {
				timer = setTimeout(flush, flushMs);
				// A pending flush must not keep a finished process alive.
				(timer as { unref?: () => void }).unref?.();
			}
		},
		async close() {
			flush();
			await chain;
		},
		scheduleDelete(run) {
			run(
				new Promise<void>((resolve) => {
					const t = setTimeout(() => {
						store
							.remove(generationId)
							.catch((err) =>
								logger.warn({ err, generationId }, "[stream-follow] could not delete a finished log")
							)
							.finally(resolve);
					}, graceMs);
					(t as { unref?: () => void }).unref?.();
				})
			);
		},
	};
}
