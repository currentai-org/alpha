import { browser } from "$app/environment";
import { base } from "$lib/chat/paths";
import type { ReasoningEffort, StreamingMode } from "$lib/chat/types/Settings";
import {
	ANSWER_PREFERENCE_KEYS,
	type AnswerLanguage,
	type Emojis,
	type Format,
	type AnswerPreferenceKey,
	type Length,
	type Tone,
} from "$lib/chat/answerPreferences";
import { getContext, setContext } from "svelte";
import { on } from "svelte/events";
import { type Writable, writable, get } from "svelte/store";
import { createSyncTracker } from "./settingsSync";
import { createAnswerSaveLane } from "./answerSaveLane";

type SettingsStore = {
	welcomeModalSeen: boolean;
	welcomeModalSeenAt: Date | null;
	activeModel: string;
	customPrompts: Record<string, string>;
	customPromptsEnabled: Record<string, boolean>;
	multimodalOverrides: Record<string, boolean>;
	artifactsOverrides: Record<string, boolean>;
	hidePromptExamples: Record<string, boolean>;
	reasoningEffortOverrides: Record<string, ReasoningEffort>;
	reasoningOverrides: Record<string, boolean>;
	recentlySaved: boolean;
	streamingMode: StreamingMode;
	directPaste: boolean;
	hapticsEnabled: boolean;
	billingOrganization?: string;
	/** How Alpha writes to this person. `undefined` is Alpha's default; never `null` here. (CUR-3929) */
	tone?: Tone;
	answerLength?: Length;
	suggestions?: boolean;
	answerLanguage?: AnswerLanguage;
	plainLanguage?: boolean;
	/** The milestone 7 fields, the same shape. (CUR-549) */
	answerFormat?: Format;
	emojis?: Emojis;
	showServing?: boolean;
	/** How Alpha refers to itself; true is the person register, `undefined` Alpha's default. (CUR-3930) */
	selfReferenceAsPerson?: boolean;
	/** Settings → Personalization, "Search my past chats". `undefined` is off. (CUR-4576) */
	searchPastChats?: boolean;
	/** Settings → Personalization, "Ask before every step". `undefined` is off: agent mode runs in auto mode. */
	agentAskEveryStep?: boolean;
	/** An answer-preference save failed and a value went back to what the server holds. (CUR-3929) */
	answerSaveFailed: boolean;
};

/** The fields the serial save lane owns (answerSaveLane.ts): every answer preference the
 *  store carries, self-reference included (CUR-3930). The debounced `setSettings` path never sends (CUR-3929)
 *  them, so two writers cannot race on one key. */
type LaneKey = AnswerPreferenceKey;
const LANE_KEYS: ReadonlyArray<LaneKey> = ANSWER_PREFERENCE_KEYS;
type AnswerPatch = Partial<Pick<SettingsStore, LaneKey>>;
type StoreSeed = Omit<SettingsStore, "recentlySaved" | "answerSaveFailed">;

type SettingsStoreWritable = Writable<SettingsStore> & {
	instantSet: (settings: Partial<SettingsStore>) => Promise<void>;
	initValue: <K extends keyof SettingsStore>(
		key: K,
		nestedKey: string,
		value: string | boolean
	) => Promise<void>;
	/** Set one answer preference, `undefined` to reset it. Optimistic, through the lane. (CUR-3929) */
	setField: <K extends LaneKey>(key: K, value: SettingsStore[K]) => Promise<void>;
	/** Set several answer preferences in one request (a preset), through the same lane. (CUR-3929) */
	setFields: (patch: AnswerPatch) => Promise<void>;
};

export function useSettingsStore() {
	return getContext<SettingsStoreWritable>("settings");
}

// POST the settings payload and drain the (empty) response body. Draining it isn't cosmetic — leaving
// a fetch's response body stream completely unconsumed lets Chromium cancel it once the Response is
// eligible for cleanup, and that shows up to any CDP/Playwright network listener as a `net::ERR_ABORTED`
// requestfailed event AFTER the real response was already logged, so a network listener such as the
// fuzz harness records a failure for a save that completed server-side (CUR-1044). Shared by all
// three call sites below rather than repeated, which the duplication gate (audit:dup:check) refuses.
//
// `keepalive` lets a save outlive the page, the way the debounced path's sendBeacon does (CUR-2574).
// Without it, a reload landing while `instantSet`'s request is in flight (dismissing the welcome,
// then reloading) cancels it, so the intro comes back. The browser caps keepalive bodies at 64 KiB in
// flight, and a body near that, a long personalization instruction, goes out without it.
const KEEPALIVE_MAX_BYTES = 32 * 1024;
async function postSettings(payload: unknown): Promise<boolean> {
	try {
		const body = JSON.stringify(payload);
		const r = await fetch(`${base}/settings`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body,
			keepalive: body.length < KEEPALIVE_MAX_BYTES,
		});
		await r.text();
		return r.ok;
	} catch {
		return false;
	}
}

export function createSettingsStore(initialValue: StoreSeed) {
	const baseStore = writable<SettingsStore>({ ...initialValue, recentlySaved: false, answerSaveFailed: false });

	let timeoutId: NodeJS.Timeout;
	let showSavedOnNextSync = false;

	// One timer hides the "Saved" pill, restarted by every save, so a second save inside the first
	// one's 3s window is not hidden by the first timer. A pill already on screen blinks off briefly
	// first, so a person sees each save acknowledged.
	let hideSavedTimer: ReturnType<typeof setTimeout> | undefined;
	function showSaved() {
		baseStore.update((s) => ({ ...s, recentlySaved: true }));
		hideSavedTimer = setTimeout(() => {
			baseStore.update((s) => ({ ...s, recentlySaved: false }));
		}, 3000);
	}
	function flashSaved() {
		clearTimeout(hideSavedTimer);
		if (get(baseStore).recentlySaved) {
			baseStore.update((s) => ({ ...s, recentlySaved: false }));
			hideSavedTimer = setTimeout(showSaved, 120);
		} else {
			showSaved();
		}
	}
	// A debounced write below (setSettings/initValue) can be discarded mid-flight by
	// a reload or tab close — the pending setTimeout simply never fires, so the toggle just
	// clicked silently reverts to whatever was last durably saved. Tracks whether a debounced
	// write is currently outstanding, so it can be flushed on the way out. (CUR-1649)
	let pendingSave = false;
	// A write carries only the fields changed since this tab's last successful save
	// (settingsSync.ts). (CUR-1643)
	const sync = createSyncTracker<StoreSeed>(initialValue);
	function dirtyFields() {
		const { recentlySaved: _saved, answerSaveFailed: _failed, ...current } = get(baseStore);
		// The lane's keys are never sent here, so a debounced save cannot carry one while the lane
		// has its own request for that key in flight.
		for (const key of LANE_KEYS) delete current[key];
		return sync.dirty(current);
	}
	async function save(fields: Partial<SettingsStore>): Promise<void> {
		await sync.save(fields, postSettings);
	}

	// The answer preferences' own save path (answerSaveLane.ts). The error is per key: a key
	// that went back to its confirmed value stays in error until that same key saves, so a later save
	// of a different key cannot hide it. (CUR-3929)
	const failedKeys = new Set<LaneKey>();
	const setFailedFlag = () =>
		baseStore.update((s) =>
			s.answerSaveFailed === failedKeys.size > 0 ? s : { ...s, answerSaveFailed: failedKeys.size > 0 }
		);
	const lane = createAnswerSaveLane<Pick<SettingsStore, LaneKey>>({
		post: postSettings,
		confirmed: (key) => sync.confirmed(key),
		recordSaved: (patch) => sync.recordSaved(patch),
		apply: (patch) => baseStore.update((s) => ({ ...s, ...patch })),
		onSaved: (saved) => {
			for (const key of Object.keys(saved) as LaneKey[]) failedKeys.delete(key);
			setFailedFlag();
			flashSaved();
		},
		onFailed: (restored) => {
			for (const key of Object.keys(restored) as LaneKey[]) failedKeys.add(key);
			setFailedFlag();
		},
	});
	function setFields(patch: AnswerPatch): Promise<void> {
		if (!browser) {
			baseStore.update((s) => ({ ...s, ...patch }));
			return Promise.resolve();
		}
		return lane.set(patch);
	}
	function setField<K extends LaneKey>(key: K, value: SettingsStore[K]): Promise<void> {
		return setFields({ [key]: value } as AnswerPatch);
	}

	// sendBeacon is the platform's purpose-built API for "flush this as the page unloads":
	// unlike fetch, the browser guarantees the request is dispatched even after the page has
	// gone away, so this survives a reload landing inside the 300ms debounce window.
	function flushPendingSave() {
		if (!browser || !pendingSave) return;
		clearTimeout(timeoutId);
		pendingSave = false;
		navigator.sendBeacon(
			`${base}/settings`,
			new Blob([JSON.stringify(dirtyFields())], { type: "application/json" })
		);
	}

	if (browser) {
		// pagehide covers reload/navigate-away/tab-close; visibilitychange also catches mobile
		// backgrounding, where pagehide isn't always guaranteed to fire in time.
		on(document, "pagehide", flushPendingSave);
		on(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") flushPendingSave();
		});
	}

	async function setSettings(settings: Partial<SettingsStore>) {
		baseStore.update((s) => ({
			...s,
			...settings,
		}));

		if (browser) {
			showSavedOnNextSync = true; // User edit, should show "Saved"
			pendingSave = true;
			clearTimeout(timeoutId);
			timeoutId = setTimeout(async () => {
				pendingSave = false;
				await save(dirtyFields());

				if (showSavedOnNextSync) flashSaved();

				showSavedOnNextSync = false;
			}, 300);
			// debounce server calls by 300ms
		}
	}

	async function initValue<K extends keyof SettingsStore>(
		key: K,
		nestedKey: string,
		value: string | boolean
	) {
		const currentStore = get(baseStore);
		const currentNestedObject = currentStore[key] as Record<string, string | boolean>;

		// Only initialize if undefined
		if (currentNestedObject?.[nestedKey] !== undefined) {
			return;
		}

		// Update the store
		const newNestedObject = {
			...(currentNestedObject || {}),
			[nestedKey]: value,
		};

		baseStore.update((s) => ({
			...s,
			[key]: newNestedObject,
		}));

		// Save to server (debounced) - note: we don't set showSavedOnNextSync
		if (browser) {
			pendingSave = true;
			clearTimeout(timeoutId);
			timeoutId = setTimeout(async () => {
				pendingSave = false;
				await save(dirtyFields());

				if (showSavedOnNextSync) flashSaved();

				showSavedOnNextSync = false;
			}, 300);
		}
	}
	async function instantSet(settings: Partial<SettingsStore>) {
		baseStore.update((s) => ({
			...s,
			...settings,
		}));

		if (browser) {
			await save(settings);
		}
	}

	const newStore = {
		subscribe: baseStore.subscribe,
		set: setSettings,
		instantSet,
		initValue,
		setField,
		setFields,
		update: (fn: (s: SettingsStore) => SettingsStore) => {
			setSettings(fn(get(baseStore)));
		},
	} satisfies SettingsStoreWritable;

	setContext("settings", newStore);

	return newStore;
}
