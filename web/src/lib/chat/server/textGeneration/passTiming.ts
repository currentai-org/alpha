import { logger } from "$lib/chat/server/logger";

// The guards
// in honestyStream.ts run synchronously over the whole answer, so one slow pass blocks the event loop
// for as long as it runs. Each pass is timed, and one that crosses SLOW_PASS_MS is logged by name with
// the length it ran over, so the next freeze names its own culprit. (CUR-3749)

/** A synchronous pass at least this slow is logged.
 *  @internal exported for its unit tests */
export const SLOW_PASS_MS = 500;

/** An answer at least this long gets a line before its end-of-stream passes, so a request killed during them still leaves its size.
 *  @internal exported for its unit tests */
export const LONG_ANSWER_CHARS = 20_000;

/** Runs `run`, and logs `pass` with its time and `text`'s length when it took SLOW_PASS_MS or longer. */
export function timedPass<T>(pass: string, text: string, run: () => T, now: () => number = () => performance.now()): T {
	const start = now();
	const result = run();
	const ms = now() - start;
	if (ms >= SLOW_PASS_MS) {
		logger.warn({ pass, ms: Math.round(ms), chars: text.length }, "[honesty] slow pass over the answer");
	}
	return result;
}

/** Logs a long answer's length before the end-of-stream passes run over it. */
export function noteLongAnswer(text: string): void {
	if (text.length >= LONG_ANSWER_CHARS) {
		logger.info({ chars: text.length }, "[honesty] end-of-stream passes starting on a long answer");
	}
}
