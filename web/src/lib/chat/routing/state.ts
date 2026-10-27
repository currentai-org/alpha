/**
 * Routing state shared across the app, all per device:
 *
 *   - the routing lab's edits to the benchmark table and scoring config, which Auto then uses on
 *     this device (so a tester can try numbers in the real composer before they're committed);
 *   - the draft analysis the composer last finished, so sending uses it instead of re-classifying;
 *   - the last language gap Alpha noticed, and the gaps the person has dismissed.
 */
import { derived, get, writable, type Writable } from 'svelte/store';
import { browser } from '$app/environment';
import { SHIPPED_BENCHMARKS, parseBenchmarkTable, type BenchmarkTable } from './benchmarks';
import { DEFAULT_ROUTING, type LanguageGap, type RoutingConfig } from './router';
import type { DraftAnalysis } from './classifier';

function persisted<T>(key: string, initial: T, parse: (raw: unknown) => T): Writable<T> {
	let start = initial;
	if (browser) {
		try {
			const raw = localStorage.getItem(key);
			if (raw !== null) start = parse(JSON.parse(raw));
		} catch {
			/* unreadable or invalid — start fresh */
		}
	}
	const store = writable<T>(start);
	if (browser) {
		// Lives for the page's lifetime, like the store itself — nothing to unsubscribe from.
		const persist = store.subscribe((v) => {
			try {
				if (v === null || v === undefined) localStorage.removeItem(key);
				else localStorage.setItem(key, JSON.stringify(v));
			} catch {
				/* storage unavailable — lasts for this page only */
			}
		});
		void persist;
	}
	return store;
}

/** The lab's edited benchmark table, or null to use the shipped one. */
export const benchmarkOverride = persisted<BenchmarkTable | null>('alpha:routing-benchmarks', null, (raw) =>
	raw === null ? null : parseBenchmarkTable(raw)
);

function parseConfig(raw: unknown): RoutingConfig | null {
	if (raw === null || typeof raw !== 'object') return null;
	// `languageWeight` (a [low, high] pair) predates `weights`; a stored config carrying it keeps its
	// other edits and gets the default weights.
	const rest = { ...raw } as Partial<RoutingConfig> & { languageWeight?: unknown };
	delete rest.languageWeight;
	const merged: RoutingConfig = {
		...DEFAULT_ROUTING,
		...rest,
		target: { ...DEFAULT_ROUTING.target, ...rest.target },
		weights: { ...DEFAULT_ROUTING.weights, ...rest.weights }
	};
	const nums = [
		merged.underCost,
		merged.weakSupport,
		merged.gapConfidence,
		merged.continuity,
		merged.capacityCost,
		...Object.values(merged.weights),
		...Object.values(merged.target)
	];
	return nums.every((n) => typeof n === 'number' && Number.isFinite(n)) ? merged : null;
}

/** The lab's edited scoring config, or null to use the defaults. */
export const routingConfigOverride = persisted<RoutingConfig | null>('alpha:routing-config', null, parseConfig);

export const activeBenchmarks = derived(benchmarkOverride, (o) => o ?? SHIPPED_BENCHMARKS);
export const activeRoutingConfig = derived(routingConfigOverride, (o) => o ?? DEFAULT_ROUTING);

/** The composer's last finished analysis and the exact (trimmed) text it describes. */
export const lastDraftAnalysis = writable<{ text: string; analysis: DraftAnalysis } | null>(null);

/** The analysis for `message` if the composer already finished it, else undefined. */
export function analysisFor(message: string): DraftAnalysis | undefined {
	const last = get(lastDraftAnalysis);
	return last && last.text === message.trim() ? last.analysis : undefined;
}

/** The most recent language gap noticed in the composer. Personalises the Contribute page. */
export const recentLanguageGap = writable<LanguageGap | null>(null);

/** Language tags whose dataset call-to-action the person closed. */
export const dismissedGaps = persisted<string[]>('alpha:dismissed-language-gaps', [], (raw) =>
	Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
);

/**
 * The served model id the composer settled on for the next message, mid-conversation. The
 * conversation page switches the conversation to it just before sending. `text` binds an automatic
 * choice to the exact draft it was made for; a choice the person made (a manual pick) has no
 * `text` and holds for whatever they send next.
 */
export const nextTurnModel = writable<{ text?: string; modelId: string } | null>(null);

/** The model to switch to before sending `message`, if the composer chose one for it. */
export function turnModelFor(message: string): string | undefined {
	const next = get(nextTurnModel);
	if (!next) return undefined;
	return next.text === undefined || next.text === message.trim() ? next.modelId : undefined;
}

/** How long a closed "Get involved" card stays closed before it comes back. */
const GET_INVOLVED_RETURN_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * When the sidebar's "Get involved" card was last closed (epoch ms), or null if never. A bare `true`
 * stored before closing expired reads as closed long ago, so the card comes back.
 */
export const getInvolvedDismissedAt = persisted<number | null>('alpha:get-involved-dismissed', null, (raw) =>
	raw === true ? 0 : typeof raw === 'number' && Number.isFinite(raw) ? raw : null
);

/** Whether the card shows: never closed, or closed more than GET_INVOLVED_RETURN_MS ago. */
export function getInvolvedVisible(dismissedAt: number | null, now: number): boolean {
	return dismissedAt === null || now - dismissedAt >= GET_INVOLVED_RETURN_MS;
}

/** Auto's choice as a turn records it (CUR-3944): the catalog id, its reason chips and sentence. */
export interface AutoRouteNote {
	model: string;
	reasons: string[];
	explanation: string;
	/** Auto's first choice, which was busy or silent, when this note is Auto picking again. (CUR-4384) */
	repickedFrom?: string;
}

/**
 * Auto's choice for the message about to be sent, bound to that message's exact (trimmed) text, so
 * the POST can tell the server Auto chose the model and why. Set where Auto decides: the landing page
 * for a first message, the composer mid-chat. A manual pick clears it.
 */
export const pendingAutoRoute = writable<{ text: string; note: AutoRouteNote } | null>(null);

/** Auto's choice for `message`, if Auto chose the model for exactly this text. */
export function autoRouteFor(message: string | undefined): AutoRouteNote | undefined {
	const pending = get(pendingAutoRoute);
	return pending && message !== undefined && pending.text === message.trim() ? pending.note : undefined;
}

/** The note a route records: what the turn's X-ray shows as Auto's step. */
export function autoRouteNote(route: { model: { id: string }; reasons: string[]; explanation: string }): AutoRouteNote {
	return { model: route.model.id, reasons: route.reasons, explanation: route.explanation };
}
