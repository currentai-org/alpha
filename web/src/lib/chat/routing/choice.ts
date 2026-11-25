/**
 * The person's model preference — "auto" (let Alpha choose per conversation) or a catalog id picked
 * from the Advanced list — and the one function that turns it into a served model id when a
 * conversation starts. Persisted per device; nothing about it is sent anywhere except the chosen id.
 */
import { writable } from 'svelte/store';
import { browser } from '$app/env';
import { catalog, servedKey } from './catalog';
import { heuristicClassify } from './heuristic';
import type { DraftAnalysis } from './classifier';
import { route, type RouteChoice, type RouteOptions } from './router';

export const AUTO = 'auto';
const STORAGE_KEY = 'alpha:model-choice';

function initial(): string {
	if (!browser) return AUTO;
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		return v && (v === AUTO || catalog.some((m) => m.id === v)) ? v : AUTO;
	} catch {
		return AUTO;
	}
}

export const modelChoice = writable<string>(initial());
if (browser) {
	// Lives for the page's lifetime, like the store itself — nothing to unsubscribe from.
	const persist = modelChoice.subscribe((v) => {
		try {
			localStorage.setItem(STORAGE_KEY, v);
		} catch {
			/* storage unavailable — the choice lasts for this page only */
		}
	});
	void persist;
}

/**
 * The catalog id the model picker shows as chosen. With Auto on it is the device's own choice. With
 * Auto off there is one preference, the model chosen in settings, so whatever this device stored
 * (Auto, or a model picked while Auto was on) is ignored.
 */
export function pickerChoice(auto: boolean, stored: string, settingsCatalogId: string | undefined): string {
	return auto ? stored : (settingsCatalogId ?? '');
}

export interface Resolution {
	/** A served model id, or undefined to keep the caller's own default. */
	modelId?: string;
	analysis?: DraftAnalysis;
	route?: RouteChoice;
	/** The name of a model the person picked that isn't served now. The caller must say so
	 *  and send nothing; falling back to its default would answer from a model they didn't pick. */
	unavailable?: string;
}

/**
 * @param choice `auto` or a catalog id.
 * @param message the first message — what Auto classifies.
 * @param servedIds ids the registry serves now; the result is always one of these, or undefined.
 * @param opts.analysis the composer's finished analysis of this exact message, when it has one;
 *   otherwise the synchronous heuristic classifies it here.
 * @param opts.largeTaskModel the served id a self-hosted operator names for large tasks
 *   (AUTO_LARGE_TASK_MODEL). Auto ranks catalogued models only, so on a stack serving none of them it
 *   would otherwise keep every turn on the default model, the frontier endpoint included.
 */
export function resolveModel(
	choice: string,
	message: string,
	servedIds: string[],
	opts: RouteOptions & { analysis?: DraftAnalysis; largeTaskModel?: string } = {}
): Resolution {
	const servedById = new Map(servedIds.map((id) => [servedKey(id), id]));
	if (choice !== AUTO) {
		const picked = catalog.find((m) => m.id === choice);
		// A model the catalog doesn't list, such as one on the person's own local server
		// (`local:<endpoint>:<model>`, localModels.ts), is picked by its served id, so it counts as
		// served exactly when that id is. Without this, every local pick would be named unavailable.
		if (!picked && servedIds.includes(choice)) return { modelId: choice };
		const id = picked?.gatewayId && servedById.get(servedKey(picked.gatewayId));
		return id ? { modelId: id } : { unavailable: picked?.name ?? choice };
	}
	const analysis = opts.analysis ?? heuristicClassify(message);
	const r = route(analysis, servedIds, opts);
	const id = r?.model.gatewayId && servedById.get(servedKey(r.model.gatewayId));
	if (id) return { modelId: id, analysis, route: r };
	// No catalogued model Auto could rank is served. A large task goes to the operator's large-task model
	// when it is served; anything else keeps the caller's default.
	const large = opts.largeTaskModel;
	if (large && analysis.difficulty.value === 'L' && servedIds.includes(large)) return { modelId: large, analysis };
	return { modelId: undefined, analysis, route: r };
}

/**
 * A model to pick as if the person had picked it in the composer's picker (a notice's "Use Mistral
 * Large 3"). ChatComposerFrame applies it, so Auto on or off and mid-chat all behave as a real pick.
 */
export const modelPickRequest = writable<string | null>(null);

/**
 * Asks the composer's model picker to open, so the person can choose another model (a timed-out turn's
 * "Try another model"). Each `requestModelPicker` bumps it; ChatComposerFrame opens on change.
 */
export const modelPickerOpenRequest = writable(0);

export function requestModelPicker(): void {
	modelPickerOpenRequest.update((n) => n + 1);
}
