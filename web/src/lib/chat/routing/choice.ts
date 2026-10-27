/**
 * The person's model preference — "auto" (let Alpha choose per conversation) or a catalog id picked
 * from the Advanced list — and the one function that turns it into a served model id when a
 * conversation starts. Persisted per device; nothing about it is sent anywhere except the chosen id.
 */
import { writable } from 'svelte/store';
import { browser } from '$app/environment';
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
	/** The name of a model the person picked that isn't served now. The caller must say so (CUR-4073)
	 *  and send nothing; falling back to its default would answer from a model they didn't pick. */
	unavailable?: string;
}

/**
 * @param choice `auto` or a catalog id.
 * @param message the first message — what Auto classifies.
 * @param servedIds ids the registry serves now; the result is always one of these, or undefined.
 * @param opts.analysis the composer's finished analysis of this exact message, when it has one;
 *   otherwise the synchronous heuristic classifies it here.
 */
export function resolveModel(
	choice: string,
	message: string,
	servedIds: string[],
	opts: RouteOptions & { analysis?: DraftAnalysis } = {}
): Resolution {
	const servedById = new Map(servedIds.map((id) => [servedKey(id), id]));
	if (choice !== AUTO) {
		const picked = catalog.find((m) => m.id === choice);
		// A model the catalog doesn't list, such as one on the person's own local server
		// (`local:<endpoint>:<model>`, localModels.ts), is picked by its served id, so it counts as
		// served exactly when that id is. Without this, every local pick would be named unavailable (CUR-4073).
		if (!picked && servedIds.includes(choice)) return { modelId: choice };
		const id = picked?.gatewayId && servedById.get(servedKey(picked.gatewayId));
		return id ? { modelId: id } : { unavailable: picked?.name ?? choice };
	}
	const analysis = opts.analysis ?? heuristicClassify(message);
	const r = route(analysis, servedIds, opts);
	const id = r?.model.gatewayId && servedById.get(servedKey(r.model.gatewayId));
	return { modelId: id || undefined, analysis, route: r };
}

/**
 * A model to pick as if the person had picked it in the composer's picker (a notice's "Use Mistral
 * Large 3"). ChatComposerFrame applies it, so Auto on or off and mid-chat all behave as a real pick.
 */
export const modelPickRequest = writable<string | null>(null);
