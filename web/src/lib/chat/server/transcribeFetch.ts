// The speech-to-text call either answers in under 2s or stalls for good, so one long abort only
// makes a stall cost more. Each attempt gets ATTEMPT_MS (about 8x the slowest healthy answer
// observed, 1,940ms), and a stalled first attempt is retried once (CUR-2328).
const ATTEMPT_MS = 15_000;
const ATTEMPTS = 2;

interface AttemptLog {
	attempt: number;
	ms: number;
	outcome: "answered" | "stalled";
}

/** Thrown after every attempt stalled. The route turns it into the 504 copy. */
export class TranscriptionStalled extends Error {
	constructor(readonly attempts: AttemptLog[]) {
		super(`transcription stalled on all ${attempts.length} attempts`);
		this.name = "TranscriptionStalled";
	}
}

/**
 * Calls `send` with a fresh abort signal per attempt. A response of any status ends the loop,
 * since a 4xx or 5xx is an answer, not a stall; only an attempt that reaches ATTEMPT_MS with no
 * response is retried. Any other error is rethrown as it is.
 */
export async function fetchWithStallRetry(
	send: (signal: AbortSignal) => Promise<Response>,
	opts: { attemptMs?: number; attempts?: number; now?: () => number } = {},
): Promise<{ response: Response; attempts: AttemptLog[] }> {
	const attemptMs = opts.attemptMs ?? ATTEMPT_MS;
	const attempts = opts.attempts ?? ATTEMPTS;
	const now = opts.now ?? Date.now;
	const log: AttemptLog[] = [];
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), attemptMs);
		const started = now();
		try {
			const response = await send(controller.signal);
			log.push({ attempt, ms: now() - started, outcome: "answered" });
			return { response, attempts: log };
		} catch (err) {
			if (!(err instanceof Error && err.name === "AbortError")) throw err;
			log.push({ attempt, ms: now() - started, outcome: "stalled" });
		} finally {
			clearTimeout(timer);
		}
	}
	throw new TranscriptionStalled(log);
}

/**
 * The type the transcriber is sent. CUR-2802: it answers `audio/mp4` with a 400 ("Content type
 * \"audio/mp4\" not supported") but takes the same container as `audio/m4a`, and Safari records
 * only mp4. The codec parameter is dropped with it, since the transcriber lists m4a bare.
 */
export function upstreamContentType(contentType: string): string {
	return contentType.startsWith("audio/mp4") ? "audio/m4a" : contentType;
}
