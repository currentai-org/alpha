// Where a LiteLLM gateway sent one request, when its response does not say so outright.
//
// The gateway names the deployment that answered on every response (`x-litellm-model-id`, a stable
// hash per deployment), but names that deployment's base URL (`x-litellm-model-api-base`) only some
// of the time; unstreamed calls in particular can carry the id without the base URL. A turn without
// the base URL would record no host, so its answer could not say where it ran.
//
// The gateway's own deployment list (`GET <base>/model/info`, readable with the same key the chat
// sends) gives each deployment's id and base URL, so the id alone is enough. This module only reads
// the gateway and never writes to it.

import { logger } from "$lib/chat/server/logger";

/**
 * The base URL a LiteLLM provider prefix calls when its deployment sets no `api_base`: LiteLLM's
 * `mistral/` provider talks to Mistral's own API. A prefix missing here (Bedrock, whose region the
 * deployment list does not carry) yields no host, so no country is claimed for it.
 */
const PROVIDER_DEFAULT_BASES: Readonly<Record<string, string>> = {
	mistral: "https://api.mistral.ai/v1",
};

type Deployment = { model_info?: { id?: unknown }; litellm_params?: { api_base?: unknown; model?: unknown } };

/** @internal exported for its unit tests. The base URL one deployment from `/model/info` sends to, or undefined when it cannot be told. */
export function deploymentBase(deployment: Deployment): string | undefined {
	const apiBase = deployment.litellm_params?.api_base;
	if (typeof apiBase === "string" && apiBase.trim()) return apiBase.trim();
	const model = deployment.litellm_params?.model;
	const prefix = typeof model === "string" && model.includes("/") ? model.split("/")[0].toLowerCase() : "";
	return Object.hasOwn(PROVIDER_DEFAULT_BASES, prefix) ? PROVIDER_DEFAULT_BASES[prefix] : undefined;
}

/** @internal exported for its unit tests. Deployment id → base URL, from a `/model/info` body. Deployments with no derivable base are left out. */
export function deploymentBases(body: unknown): Map<string, string> {
	const out = new Map<string, string>();
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return out;
	for (const deployment of data as Deployment[]) {
		const id = deployment?.model_info?.id;
		const base = deploymentBase(deployment ?? {});
		if (typeof id === "string" && id && base) out.set(id, base);
	}
	return out;
}

const FRESH_MS = 10 * 60_000;
// A failed read, or an id the last list lacked (a deployment added since), waits a minute before the
// next read. A gateway that refuses the route then costs one request a minute, whatever the traffic.
const REREAD_AFTER_MS = 60_000;
const READ_TIMEOUT_MS = 1_500;

type Entry = { at: number; ok: boolean; bases: Map<string, string>; pending?: Promise<void> };
const cache = new Map<string, Entry>();

/** @internal Test hook: forget every cached deployment list. */
export function resetGatewayDeployments(): void {
	cache.clear();
}

function needsRead(entry: Entry | undefined, id: string, now: number): boolean {
	if (!entry) return true;
	const age = now - entry.at;
	if (!entry.ok || !entry.bases.has(id)) return age > REREAD_AFTER_MS;
	return age > FRESH_MS;
}

/**
 * The base URL of the deployment `deploymentId` names on the gateway at `baseURL`. The gateway's
 * deployment list is cached per gateway for ten minutes. Undefined when there is no id, the list
 * cannot be read in time, or the deployment is missing from it. The caller then records no host,
 * and the answer says its host was not recorded.
 */
export async function backendForDeployment(
	deploymentId: string | null | undefined,
	opts: { baseURL: string; authorization?: string | null; fetchImpl?: typeof fetch; now?: () => number }
): Promise<string | undefined> {
	const id = deploymentId?.trim();
	if (!id) return undefined;
	const now = opts.now ?? Date.now;
	const key = opts.baseURL.replace(/\/+$/, "");
	let entry = cache.get(key);
	if (needsRead(entry, id, now())) {
		if (!entry) {
			entry = { at: 0, ok: false, bases: new Map() };
			cache.set(key, entry);
		}
		const target = entry;
		target.pending ??= readDeployments(key, opts.authorization, opts.fetchImpl ?? fetch)
			.then((bases) => {
				target.bases = bases;
				target.ok = true;
			})
			.catch((err: unknown) => {
				target.ok = false;
				logger.warn({ gateway: new URL(key).host, err: String(err) }, "[serving] gateway deployment list unreadable");
			})
			.finally(() => {
				target.at = now();
				target.pending = undefined;
			});
		await target.pending;
	}
	return entry?.bases.get(id);
}

async function readDeployments(
	baseURL: string,
	authorization: string | null | undefined,
	fetchImpl: typeof fetch
): Promise<Map<string, string>> {
	const res = await fetchImpl(`${baseURL}/model/info`, {
		method: "GET",
		headers: authorization ? { authorization } : {},
		signal: AbortSignal.timeout(READ_TIMEOUT_MS),
	});
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		throw new Error(`model/info answered ${res.status}`);
	}
	return deploymentBases(await res.json());
}
