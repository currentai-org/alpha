// CUR-2092. Two rules for every call to an Apertus group on the LiteLLM gateway:
//
//   1. `disable_fallbacks: true`, so the gateway refuses rather than answering as SEA-LION.
//   2. The answer lane's request, when it carries a non-user role, is pinned to a deployment that
//      accepts roles. Side calls are not pinned (endpointOai.ts says why).
//
// Why: the gateway's `swiss-ai/apertus-v1.5-70b` group pools two deployments (`GET /v1/model/info`),
// and one of them answers a system or assistant role with `400 Insufficient capacity … All
// endpoints at capacity`. LiteLLM does not retry a 400 on the other deployment. On the preview
// upstream key, a role-shaped request to the group with no fallbacks is served only by the
// role-accepting deployment and gets the other's 400 otherwise; with fallbacks allowed, about half are
// answered by a different model (SEA-LION). A request pinned to the role-accepting deployment id is
// served, and a flattened (user role only) one is served by both deployments.
//
// The pin is resolved at runtime from the gateway's own `/v1/model/info`, so an edit to the gateway
// config moves with it. A pinned response names the deployment id where the group would be, in the
// `x-litellm-model-group` header and in every chunk; `servedGroupFor` maps it back so the
// substitution check and the provenance badge see the group they asked for.
//
// Which models take the lane is their `strictLane` field in harnessProfiles.ts (CUR-2697).

import { logger } from "$lib/chat/server/logger";

/**
 * Which deployment hosts serve real system/assistant roles, per gateway group. The one place a
 * provider's request-shape quirk is written down. A group missing here is never pinned.
 */
const ROLE_CAPABLE_HOSTS: Readonly<Record<string, readonly string[]>> = {
	"swiss-ai/apertus-v1.5-70b": ["api.infomaniak.com"],
};

type ModelInfoEntry = {
	model_name?: string;
	litellm_params?: { api_base?: string };
	model_info?: { id?: string };
};

const TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;

type Cache = { at: number; ttl: number; entries: ModelInfoEntry[] };
const caches = new Map<string, Cache>();
const inflight = new Map<string, Promise<ModelInfoEntry[]>>();
/** Deployment id → the group it belongs to, for every pin handed out. */
const pinnedGroups = new Map<string, string>();

function hostOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

async function loadModelInfo(
	baseURL: string,
	apiKey: string | undefined,
	fetchImpl: typeof fetch
): Promise<ModelInfoEntry[]> {
	const key = baseURL;
	const cached = caches.get(key);
	if (cached && Date.now() - cached.at < cached.ttl) return cached.entries;
	const pending = inflight.get(key);
	if (pending) return pending;

	const run = (async () => {
		try {
			const res = await fetchImpl(`${baseURL.replace(/\/$/, "")}/model/info`, {
				headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`model/info answered ${res.status}`);
			const json = (await res.json()) as { data?: ModelInfoEntry[] };
			const entries = Array.isArray(json.data) ? json.data : [];
			caches.set(key, { at: Date.now(), ttl: TTL_MS, entries });
			return entries;
		} catch (err) {
			// Loud, and short-lived: an unreachable model/info means no pin, which is today's behavior.
			logger.warn(
				{ leg: "strict-lane", baseURL, err: (err as Error).message },
				"[strict-lane] could not read the gateway's model/info — requests go to the group unpinned"
			);
			caches.set(key, { at: Date.now(), ttl: FAILURE_TTL_MS, entries: [] });
			return [];
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, run);
	return run;
}

/**
 * The deployment id to send a role-shaped request for `group` to, or undefined to send it to the
 * group as-is (no role-capable host listed, or none found in the gateway's current config).
 */
export async function roleCapableDeployment(
	group: string,
	baseURL: string,
	apiKey: string | undefined,
	fetchImpl: typeof fetch = fetch
): Promise<string | undefined> {
	const hosts = ROLE_CAPABLE_HOSTS[group.trim().toLowerCase()];
	if (!hosts?.length) return undefined;
	const entries = await loadModelInfo(baseURL, apiKey, fetchImpl);
	const match = entries.find(
		(e) =>
			e.model_name?.toLowerCase() === group.trim().toLowerCase() &&
			hosts.includes(hostOf(e.litellm_params?.api_base) ?? "") &&
			!!e.model_info?.id
	);
	const id = match?.model_info?.id;
	if (id) pinnedGroups.set(id, group);
	return id;
}

/** True when any message carries a role other than `user`, which is what Featherless rejects. */
export function carriesNonUserRole(messages: ReadonlyArray<{ role: string }>): boolean {
	return messages.some((m) => m.role !== "user");
}

/** Maps a pinned deployment id back to its group; any other id comes back unchanged. */
export function servedGroupFor(id: string | undefined): string | undefined {
	if (!id) return id;
	return pinnedGroups.get(id) ?? id;
}

/** Test seam: forget every cached lookup and pin. */
export function resetStrictLaneCacheForTests(): void {
	caches.clear();
	inflight.clear();
	pinnedGroups.clear();
}
