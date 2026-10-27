/**
 * When to ask a hosted classifier about the draft, so typing never hammers it.
 *
 * The local read answers every pause (draftAnalysis.svelte.ts, 350 ms). A hosted read costs a round
 * trip of one to three seconds and a model call, so it is asked far less often:
 *
 *   - only after a longer pause (`idleMs`), and only for a draft of `minChars` or more;
 *   - one request at a time per composer. Typing while one is out queues the newest draft, which is
 *     asked once the first returns; drafts in between are never sent;
 *   - not again for a small edit: a read stays valid for any draft that shares 85% of its text and
 *     differs by at most 40 characters, so adding a word or fixing a typo reuses it;
 *   - exact drafts it has already read (deleting back to an earlier draft) come from a small cache;
 *   - after a refusal it stops: a 404 or 403 (the feature is off for this person) for good, a 429
 *     or three failures in a row for a minute.
 *
 * Plain TypeScript with an `onChange` callback, so it can be tested with fake timers and wrapped by a
 * rune in the composer.
 */
import { base } from '$lib/chat/paths';
import type { ClefVerdict } from './clef';

export const REMOTE_IDLE_MS = 900;
const REMOTE_MIN_CHARS = 12;
const NEAR_SHARED = 0.85;
const NEAR_MAX_CHARS = 40;
const CACHE_SIZE = 32;
const MAX_FAILURES = 3;
const PAUSE_MS = 60_000;

export class RemoteReadError extends Error {
	constructor(readonly status: number) {
		super(`remote read failed: ${status}`);
	}
}

/** The same draft for routing purposes: collapsed whitespace, trimmed. */
const normalizeDraft = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Whether a read of `a` still describes draft `b` (a small edit apart). */
export function isNearDraft(a: string, b: string): boolean {
	if (a === b) return true;
	const longer = Math.max(a.length, b.length);
	if (Math.abs(a.length - b.length) > NEAR_MAX_CHARS) return false;
	let shared = 0;
	while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
	return shared >= NEAR_SHARED * longer && longer - shared <= NEAR_MAX_CHARS;
}

export interface RemoteReaderOptions<V> {
	read: (text: string, signal: AbortSignal) => Promise<V>;
	/** Called whenever a read lands or the in-flight state changes. */
	onChange?: () => void;
	idleMs?: number;
	minChars?: number;
	now?: () => number;
}

export class RemoteReader<V> {
	#opts: Required<Omit<RemoteReaderOptions<V>, 'onChange'>> & Pick<RemoteReaderOptions<V>, 'onChange'>;
	#cache = new Map<string, V>();
	#latest: { text: string; value: V } | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#ctrl: AbortController | undefined;
	#queued: string | undefined;
	#failures = 0;
	#pausedUntil = 0;
	#disabled = false;
	/** How many reads were sent. For tests and the routing lab. */
	sent = 0;

	constructor(opts: RemoteReaderOptions<V>) {
		// `??`, not a spread: an option passed as `undefined` must not erase its default (a 0 ms idle
		// sends a read on every keystroke).
		this.#opts = {
			read: opts.read,
			onChange: opts.onChange,
			idleMs: opts.idleMs ?? REMOTE_IDLE_MS,
			minChars: opts.minChars ?? REMOTE_MIN_CHARS,
			now: opts.now ?? (() => Date.now())
		};
	}

	get inFlight(): boolean {
		return this.#ctrl !== undefined;
	}

	/** The read that describes `text`: an exact one, else the latest if it's a small edit away. */
	readFor(text: string): V | undefined {
		const t = normalizeDraft(text);
		if (!t) return undefined;
		const exact = this.#cache.get(t);
		if (exact !== undefined) return exact;
		return this.#latest && isNearDraft(this.#latest.text, t) ? this.#latest.value : undefined;
	}

	/** The draft changed. Call on every change; it decides whether and when to ask. */
	want(text: string): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const t = normalizeDraft(text);
		if (!this.#needs(t)) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			// A read that landed during the pause may already cover this draft.
			if (this.#needs(t)) this.#ask(t);
		}, this.#opts.idleMs);
	}

	dispose(): void {
		clearTimeout(this.#timer);
		this.#ctrl?.abort();
		this.#ctrl = undefined;
		this.#queued = undefined;
		this.#disabled = true;
	}

	#needs(t: string): boolean {
		if (this.#disabled || this.#opts.now() < this.#pausedUntil) return false;
		if (t.length < this.#opts.minChars) return false;
		return this.readFor(t) === undefined;
	}

	#ask(t: string): void {
		if (this.#ctrl) {
			this.#queued = t;
			return;
		}
		const ctrl = new AbortController();
		this.#ctrl = ctrl;
		this.sent++;
		this.#opts.onChange?.();
		this.#opts
			.read(t, ctrl.signal)
			.then((value) => {
				if (ctrl.signal.aborted) return;
				this.#failures = 0;
				this.#cache.delete(t);
				this.#cache.set(t, value);
				if (this.#cache.size > CACHE_SIZE) this.#cache.delete(this.#cache.keys().next().value!);
				this.#latest = { text: t, value };
			})
			.catch((e: unknown) => {
				if (ctrl.signal.aborted) return;
				const status = e instanceof RemoteReadError ? e.status : 0;
				if (status === 404 || status === 403) this.#disabled = true;
				else if (status === 429 || ++this.#failures >= MAX_FAILURES) {
					this.#pausedUntil = this.#opts.now() + PAUSE_MS;
					this.#failures = 0;
				}
			})
			.finally(() => {
				if (ctrl.signal.aborted) return;
				this.#ctrl = undefined;
				const next = this.#queued;
				this.#queued = undefined;
				this.#opts.onChange?.();
				if (next !== undefined && this.#needs(next)) this.#ask(next);
			});
	}
}

/** Ask the server's Clef route about a draft. Throws RemoteReadError on any non-2xx. */
export async function readWithClef(text: string, signal: AbortSignal): Promise<ClefVerdict> {
	const res = await fetch(`${base}/api/routing/classify`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ text }),
		signal
	});
	if (!res.ok) throw new RemoteReadError(res.status);
	return (await res.json()) as ClefVerdict;
}
