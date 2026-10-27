/**
 * Hard-deadline plumbing for the generation stream (conversation/[id]/+server.ts).
 *
 * The 45s generation watchdog calls ctrl.abort() on a stalled turn — but an abort only helps when
 * the awaited upstream generator actually honors it. When it doesn't, the watchdog fires, the abort is
 * called, and the stream still never unwinds — no terminal Status/Error, no persist, no
 * finishGeneration, no close — until Vercel kills the invocation at maxDuration (300s), leaving the
 * client spinning with nothing persisted.
 *
 * raceGenerationDeadline is the backstop for exactly that: the route races the WHOLE generation
 * work (its own try/catch/finally included) against a hard deadline. When the deadline wins, the
 * route regains control unconditionally and can emit a terminal error, persist, finalize the W2
 * record, and close the stream — abandoning the hung promise instead of waiting on it.
 */

/**
 * The reason the route's generation watchdog and hard deadline abort a turn with (CUR-4660).
 *
 * Its name is "AbortError", so every check that reads an abort by name treats it as before. An
 * endpoint that must tell the watchdog ending a turn from a person pressing Stop reads it off the
 * signal with `endedByWatchdog`: an agent turn's open approval card, for one, went unanswered in the
 * first case and was canceled in the second.
 */
export class GenerationWatchdogAbort extends DOMException {
	constructor() {
		super("the generation watchdog ended this turn", "AbortError");
	}
}

/** Whether `signal` was aborted by the route's watchdog or hard deadline rather than by a Stop. */
export function endedByWatchdog(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true && signal.reason instanceof GenerationWatchdogAbort;
}

/** Thrown (rejected) by raceGenerationDeadline when the deadline wins the race. */
export class GenerationDeadlineExceeded extends Error {
	constructor(readonly deadlineMs: number) {
		super(`generation exceeded the hard deadline of ${deadlineMs}ms`);
		this.name = "GenerationDeadlineExceeded";
	}
}

/**
 * Race `work` against a hard deadline. Resolves/rejects with `work`'s outcome when it settles in
 * time; rejects with GenerationDeadlineExceeded when the deadline wins. The deadline timer is
 * cleared as soon as `work` settles, so a finished turn never keeps a timer (or a late spurious
 * side effect) alive. The caller owns the abandoned `work` promise on the deadline path — attach a
 * no-op catch to it if its eventual rejection must not surface as an unhandled rejection.
 */
export async function raceGenerationDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new GenerationDeadlineExceeded(deadlineMs)), deadlineMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A generation deadline whose clock starts when the input screen ends (CUR-3749).
 *
 * Armed when the watchdog is, before the turn has its screen verdict. While the screen runs, the
 * deadline sits `allowanceMs` past `baseMs`, so a long paste's screen can't run the turn out of time.
 * `screenSettled()` then fixes the extension at the time actually spent waiting (never more than the
 * allowance) and re-arms every timer scheduled on it, so a screen that took 2s leaves the turn
 * `baseMs` from then, and one that hung past the allowance gets no more than the allowance.
 *
 * The time a person spends answering a confirm card is not generation time either (CUR-3983).
 * `setHumanWaiting(true)` holds the deadline open for as long as the wait lasts, and
 * `setHumanWaiting(false)` adds what it really took. A turn still streaming at its deadline can take
 * what room is left with `extendWhileStreaming()` (CUR-4009). Screen, human waits and streaming
 * together never extend the deadline past `roomMs`, so a caller passing MAX_SAFE − baseMs keeps the
 * ladder's invariant.
 */
export class ScreenAwareDeadline {
	private readonly armedAt: number;
	private extensionMs: number | undefined;
	private humanMs = 0;
	private streamMs = 0;
	private humanWaitStartedAt: number | undefined;
	private readonly rearms = new Set<() => void>();

	constructor(
		readonly baseMs: number,
		readonly allowanceMs: number,
		private readonly now: () => number = Date.now,
		/** Most the screen and human waits may add together. Defaults to the screen allowance. */
		readonly roomMs: number = allowanceMs
	) {
		this.armedAt = now();
	}

	private rearmAll(): void {
		for (const rearm of [...this.rearms]) rearm();
	}

	/** The screen's verdict is in. Only the first call counts. */
	screenSettled(): void {
		if (this.extensionMs !== undefined) return;
		this.extensionMs = Math.min(Math.max(0, this.now() - this.armedAt), this.allowanceMs);
		this.rearmAll();
	}

	/** Room the human wait may still take, after the screen, the waits already settled and any
	 *  streaming extension. */
	private humanRoomLeftMs(): number {
		return Math.max(0, this.roomMs - this.screenExtensionMs - this.humanMs - this.streamMs);
	}

	/**
	 * The turn is still streaming as its deadline arrives (CUR-4009): give it all the room left, once,
	 * and re-arm every timer. A long answer on a slow lane is not a stall, and the silence watchdog
	 * still ends one that stops. Staying inside `roomMs` keeps the ladder's invariant. Returns the
	 * milliseconds added, 0 when there was no room or the extension was already taken.
	 */
	extendWhileStreaming(): number {
		if (this.streamMs > 0) return 0;
		this.streamMs = Math.max(0, this.roomMs - this.screenExtensionMs - this.humanExtensionMs);
		if (this.streamMs > 0) this.rearmAll();
		return this.streamMs;
	}

	/** A confirm card opened (true) or was answered (false). Repeating the current state does nothing. */
	setHumanWaiting(waiting: boolean): void {
		if (waiting === (this.humanWaitStartedAt !== undefined)) return;
		if (waiting) {
			this.humanWaitStartedAt = this.now();
		} else {
			const waited = Math.max(0, this.now() - (this.humanWaitStartedAt ?? this.now()));
			this.humanMs += Math.min(waited, this.humanRoomLeftMs());
			this.humanWaitStartedAt = undefined;
		}
		this.rearmAll();
	}

	/** Time human waits added: what settled waits took, plus all the room left while one is open. */
	get humanExtensionMs(): number {
		return this.humanMs + (this.humanWaitStartedAt !== undefined ? this.humanRoomLeftMs() : 0);
	}

	/** Time a still-streaming turn was given past its deadline (CUR-4009). */
	get streamExtensionMs(): number {
		return this.streamMs;
	}

	/** Time the screen added: the allowance until it settles, then what it really took. */
	get screenExtensionMs(): number {
		return this.extensionMs ?? this.allowanceMs;
	}

	/** Milliseconds from now until the deadline plus `extraMs`. Negative once it has passed. */
	remainingMs(extraMs = 0): number {
		return (
			this.armedAt +
			this.baseMs +
			this.screenExtensionMs +
			this.humanExtensionMs +
			this.streamMs +
			extraMs -
			this.now()
		);
	}

	/** Run `onFire` once the deadline plus `extraMs` passes, re-armed when the screen settles. Returns
	 *  the function that cancels it. */
	schedule(onFire: () => void, extraMs = 0): () => void {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const arm = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				this.rearms.delete(arm);
				onFire();
			}, Math.max(0, this.remainingMs(extraMs)));
		};
		this.rearms.add(arm);
		arm();
		return () => {
			clearTimeout(timer);
			this.rearms.delete(arm);
		};
	}
}

/**
 * raceGenerationDeadline against a ScreenAwareDeadline: `work` loses once the deadline plus `graceMs`
 * passes, measured from when the screen ended rather than from when the race began.
 */
export async function raceScreenAwareDeadline<T>(
	work: Promise<T>,
	deadline: ScreenAwareDeadline,
	graceMs: number
): Promise<T> {
	let cancel: (() => void) | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				cancel = deadline.schedule(
					() =>
						reject(
							new GenerationDeadlineExceeded(
								deadline.baseMs +
									deadline.screenExtensionMs +
									deadline.humanExtensionMs +
									deadline.streamExtensionMs +
									graceMs
							)
						),
					graceMs
				);
			}),
		]);
	} finally {
		cancel?.();
	}
}

/**
 * Await `p` for at most `ms`, swallowing its rejection — for the emergency-cleanup path only.
 * Once the hard deadline has fired, the dependencies behind persist/finalize may be the very thing
 * that hung, so cleanup must be best-effort AND bounded: a cleanup step that hangs forever would
 * recreate the 300s-kill it exists to prevent. Resolves undefined on timeout or rejection.
 */
export async function boundedSettle<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			p.catch(() => undefined),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
