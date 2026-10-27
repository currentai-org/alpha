import type { APIRequestContext } from '@playwright/test';

// Which model a scenario is running against. The default model can change, and a spec that named one
// in its assertions went red when it did (CUR-2272, CUR-2283). A
// spec asserts on the model the target actually serves, read here, and a spec that only makes sense
// for one model pins it with `pinnedChatEntry` instead of relying on whatever the default is.

export type ServedModel = {
	id: string;
	displayName: string;
	supportsTools: boolean;
};

/** Every model the target lists, in the order the app renders them. */
export async function listedModels(request: APIRequestContext): Promise<ServedModel[]> {
	const res = await request.get('/chat/api/v2/models');
	if (!res.ok()) throw new Error(`/chat/api/v2/models answered ${res.status()}`);
	const body = (await res.json()) as { json?: ServedModel[] } | ServedModel[];
	return Array.isArray(body) ? body : (body.json ?? []);
}

/**
 * The model a new chat starts on: the first entry of the list the app itself renders from
 * (`models.ts`, `defaultModel = models[0]`).
 */
export async function defaultModel(request: APIRequestContext): Promise<ServedModel> {
	const models = await listedModels(request);
	const first = models[0];
	if (!first?.id || !first.displayName) {
		throw new Error(`/chat/api/v2/models listed no usable default: ${JSON.stringify(models[0])}`);
	}
	return { id: first.id, displayName: first.displayName, supportsTools: !!first.supportsTools };
}

/** A chat entry that starts the conversation on `modelId`, whatever the target's default is. */
export function pinnedChatEntry(modelId: string): string {
	return `/chat/models/${modelId}`;
}

/**
 * `models` with every Apertus row moved to the end. A spec that needs some model of a kind (no tools,
 * self-hosted) and not Apertus in particular picks from this, so Apertus answers only the specs that
 * name it: listed first among the models without tools, it would fail every such spec whenever
 * its lane went quiet (CUR-3982), though other models answered on the same deployment.
 */
export function apertusLast<T extends { id: string }>(models: T[]): T[] {
	const apertus = (m: T) => /apertus/i.test(m.id);
	return [...models.filter((m) => !apertus(m)), ...models.filter(apertus)];
}

/**
 * The first listed model that cannot call tools, Apertus only when nothing else qualifies. Math routing plans a turn only for such a model
 * (CUR-2282): a tool-capable one calls `calculate` itself and never produces a `math-route` rung, so a
 * spec about the planner started on one would read "undefined" for a reason that has nothing to do
 * with the planner.
 */
export async function modelWithoutTools(request: APIRequestContext): Promise<ServedModel> {
	const res = await request.get('/chat/api/v2/models');
	if (!res.ok()) throw new Error(`/chat/api/v2/models answered ${res.status()}`);
	const body = (await res.json()) as { json?: ServedModel[] } | ServedModel[];
	const models = Array.isArray(body) ? body : (body.json ?? []);
	const pick = apertusLast(models).find((m) => m.id && !m.supportsTools);
	if (!pick) {
		throw new Error(
			`/chat/api/v2/models lists no model without tools, so math routing plans no turn here: ` +
				JSON.stringify(models.map((m) => m.id))
		);
	}
	return { id: pick.id, displayName: pick.displayName, supportsTools: false };
}
