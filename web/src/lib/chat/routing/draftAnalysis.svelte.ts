/**
 * Debounced draft classification for a component: as the person types, wait for a pause, run the
 * draft through a `DraftClassifier`, and expose the latest finished result. The previous result
 * stays visible while a newer one is pending, so the picker doesn't flicker on every keystroke;
 * `pending` says a fresher one is on its way. A classifier failure falls back to the synchronous
 * heuristic rather than leaving the picker without an answer.
 *
 * With `remote`, a hosted classifier refines the local read: the local answer still lands after
 * every short pause, and a hosted read (asked sparingly, see remoteRead.ts) is merged over it
 * whenever one describes the current draft. The hosted read never delays or replaces the local one;
 * when it fails or is slow, the local read is what the picker and the send path use.
 */
import { untrack } from 'svelte';
import { heuristicClassify } from './heuristic';
import type { DraftAnalysis, DraftClassifier } from './classifier';
import { localClassifier } from './localClassifier';
import { RemoteReader } from './remoteRead';
import { lastDraftAnalysis } from './state';

/** Long enough to skip mid-word keystrokes, short enough to feel live. */
export const DRAFT_DEBOUNCE_MS = 350;
/** Fewer characters than this can't be classified. */
export const MIN_DRAFT_CHARS = 3;

/** A hosted classifier that refines the local read. */
interface RemoteRefiner<V> {
	read: (text: string, signal: AbortSignal) => Promise<V>;
	merge: (text: string, local: DraftAnalysis, verdict: V) => DraftAnalysis;
	idleMs?: number;
	/** Read reactively; false stops sending drafts (a read already out still lands). */
	active?: () => boolean;
}

export interface DraftAnalysisOptions<V = unknown> {
	delay?: number;
	classifier?: DraftClassifier;
	/** Refine with a hosted classifier. Read once, when the hook is created. */
	remote?: RemoteRefiner<V>;
	/** Publish results to `lastDraftAnalysis` so sending can reuse them. The composer does. */
	publish?: boolean;
}

export function useDraftAnalysis<V = unknown>(getText: () => string, opts: DraftAnalysisOptions<V> = {}) {
	const delay = opts.delay ?? DRAFT_DEBOUNCE_MS;
	const classify = opts.classifier ?? localClassifier;

	let local = $state<DraftAnalysis | undefined>();
	let analyzedText = $state('');
	let pending = $state(false);

	// Bumped whenever the remote reader lands a read or starts/finishes one.
	let remoteTick = $state(0);
	const remote = opts.remote;
	const reader = remote
		? new RemoteReader<V>({ read: remote.read, idleMs: remote.idleMs, onChange: () => remoteTick++ })
		: undefined;

	function settle(text: string, analysis: DraftAnalysis | undefined) {
		local = analysis;
		analyzedText = text;
		pending = false;
	}

	$effect(() => {
		const text = getText().trim();
		const send = remote?.active?.() ?? true;
		untrack(() => reader?.want(send ? text : ''));
		if (text.length < MIN_DRAFT_CHARS) {
			untrack(() => settle('', undefined));
			return;
		}
		if (untrack(() => text === analyzedText && local)) return;

		pending = true;
		const ctrl = new AbortController();
		const timer = setTimeout(async () => {
			let analysis: DraftAnalysis;
			try {
				analysis = await classify(text, { signal: ctrl.signal });
			} catch {
				if (ctrl.signal.aborted) return;
				analysis = heuristicClassify(text);
			}
			if (!ctrl.signal.aborted) settle(text, analysis);
		}, delay);
		return () => {
			clearTimeout(timer);
			ctrl.abort();
		};
	});

	$effect(() => () => reader?.dispose());

	const current = $derived.by(() => {
		void remoteTick;
		if (!local || !remote || !reader || remote.active?.() === false) return local;
		const verdict = reader.readFor(analyzedText);
		return verdict === undefined ? local : remote.merge(analyzedText, local, verdict);
	});
	const refining = $derived.by(() => {
		void remoteTick;
		return reader?.inFlight ?? false;
	});

	if (opts.publish) {
		$effect(() => {
			const analysis = current;
			const text = analyzedText;
			lastDraftAnalysis.set(analysis ? { text, analysis } : null);
		});
	}

	return {
		/** The latest finished analysis, or undefined when the draft is too short. */
		get current() {
			return current;
		},
		/** The text `current` describes. */
		get text() {
			return analyzedText;
		},
		/** A newer local analysis is on its way. */
		get pending() {
			return pending;
		},
		/** A hosted read is in flight. */
		get refining() {
			return refining;
		},
		/** How many hosted reads were sent (the routing lab shows it). */
		get remoteSent() {
			void remoteTick;
			return reader?.sent ?? 0;
		}
	};
}
