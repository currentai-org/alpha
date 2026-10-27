// Which settings fields a write has to carry. A write that posted the whole local store
// would let a tab that loaded before another tab's change send its stale copy back and revert it. The server
// persists only the fields a body names, and a write names only the fields that differ from what
// this tab last saved. Values are compared as JSON, since `$settings.customPrompts[id] = …` mutates the
// nested object in place and an identity check would miss it.
//
// A field is marked saved only after the server took it. A failed save leaves it dirty, so the next
// save resends it. (CUR-1643)

export type SyncTracker<T extends object> = {
	/** Fields whose current value differs from the last one saved. */
	dirty(current: T): Partial<T>;
	/** POST `fields` with `post`; on success, record them as saved. */
	save(fields: Partial<T>, post: (fields: Partial<T>) => Promise<boolean>): Promise<boolean>;
	/** Record `fields` as saved without posting, for a write made outside `save`. (CUR-3929) */
	recordSaved(fields: Partial<T>): void;
	/** The last value the server took for `key`, as this tab last saw it; `undefined` when (CUR-3929)
	 *  none, or when the last saved value was a reset. */
	confirmed<K extends keyof T>(key: K): T[K] | undefined;
};

export function createSyncTracker<T extends object>(saved: T): SyncTracker<T> {
	// `undefined` has no JSON form, so an unset field is kept as `undefined` and compares equal to
	// another unset.
	const encode = (value: unknown) => (value === undefined ? undefined : JSON.stringify(value));
	const last = new Map<string, string | undefined>(
		Object.entries(saved).map(([key, value]) => [key, encode(value)])
	);
	const recordSaved = (fields: Partial<T>) => {
		for (const [key, value] of Object.entries(fields)) last.set(key, encode(value));
	};
	return {
		dirty(current) {
			return Object.fromEntries(
				Object.entries(current).filter(([key, value]) => last.get(key) !== encode(value))
			) as Partial<T>;
		},
		async save(fields, post) {
			const ok = await post(fields);
			if (ok) recordSaved(fields);
			return ok;
		},
		recordSaved,
		confirmed(key) {
			const value = last.get(key as string);
			return value === undefined ? undefined : (JSON.parse(value) as T[typeof key]);
		},
	};
}
