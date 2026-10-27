// One serial save lane for the answer preferences. The store takes a change at once; the
// lane sends one request at a time, and changes made while one is in flight coalesce into a pending
// patch (latest value per key) that goes out as the next single request. So the database receives
// this tab's writes in the order the person made them, and a reset can never overtake a later choice.
//
// A value of `undefined` in a patch is a reset: it reaches the store as `undefined` (Alpha's default)
// and the wire as `null`, which the server turns into an unset (applySettingsUpdate.ts). The store
// never holds `null`.
//
// Failure is recovered per key: a key whose request failed goes back to the value the server last
// acknowledged, unless the pending patch holds a newer value for that same key, since that value's own
// request goes out next. Pure: no Svelte, no fetch, so it is unit-tested on its own. (CUR-3929)

type WireBody = Record<string, unknown>;

export interface AnswerSaveLaneHooks<P extends object> {
	/** POST one body. `null` is a reset on the wire. Resolves true on a 2xx. */
	post(body: WireBody): Promise<boolean>;
	/** The last value the server acknowledged for `key`; `undefined` when none, or when it was a reset. */
	confirmed<K extends keyof P>(key: K): P[K] | undefined;
	/** Record a body the server took. */
	recordSaved(patch: Partial<P>): void;
	/** Write these values into the store now. A key set to `undefined` is a reset. */
	apply(patch: Partial<P>): void;
	/** A request succeeded; `saved` is the body the server took. */
	onSaved(saved: Partial<P>): void;
	/** A request failed and `restored` is what went back to its confirmed value; empty when every
	 *  failed key had a newer value pending. */
	onFailed(restored: Partial<P>): void;
}

export interface AnswerSaveLane<P extends object> {
	/** Apply `patch` to the store at once and queue it. Resolves when the lane drains. */
	set(patch: Partial<P>): Promise<void>;
	/** True while a request is in flight. */
	busy(): boolean;
}

function toWire<P extends object>(patch: Partial<P>): WireBody {
	return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value]));
}

export function createAnswerSaveLane<P extends object>(hooks: AnswerSaveLaneHooks<P>): AnswerSaveLane<P> {
	let pending: Partial<P> | null = null;
	let inFlight: Promise<void> | null = null;

	async function drain(): Promise<void> {
		while (pending) {
			const body = pending;
			pending = null;
			const ok = await hooks.post(toWire(body));
			if (ok) {
				hooks.recordSaved(body);
				hooks.onSaved(body);
				continue;
			}
			const restored: Partial<P> = {};
			for (const key of Object.keys(body) as (keyof P)[]) {
				if (pending && key in pending) continue;
				restored[key] = hooks.confirmed(key);
			}
			if (Object.keys(restored).length) hooks.apply(restored);
			hooks.onFailed(restored);
		}
	}

	return {
		set(patch) {
			hooks.apply(patch);
			pending = { ...(pending ?? {}), ...patch };
			if (!inFlight) {
				inFlight = drain().finally(() => {
					inFlight = null;
				});
			}
			return inFlight;
		},
		busy: () => inFlight !== null,
	};
}
