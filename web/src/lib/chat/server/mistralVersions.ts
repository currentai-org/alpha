// Which dated Mistral model an alias like `mistral-large-latest` names today, read from La Plateforme's
// own model list (CUR-2928). The staging router asks Mistral for `*-latest` and reports back its own
// alias, so neither the body nor the headers name the version that answered; this list is the check.
// The router's `/mistral/v1/models` passthrough serves the same list to chat's own router key, so it is
// read first and La Plateforme's key is only a fallback: a retired key makes La Plateforme answer 401,
// which would credit every answer as `*-latest`.
import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";
import { mistralChatLane, mistralPlateforme } from "$lib/chat/server/mistralKey";

const TTL_MS = 60 * 60 * 1000;
// The router's list takes 0.9 s to over 20 s to answer, so the read itself is
// allowed 15 s but an answer waits at most 2 s for it. A read that outlives the wait finishes in the
// background and serves the next answer; a table already read keeps serving while it is refreshed.
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const ANSWER_WAIT_MS = 2_000;

/**
 * What Mistral's list said when the router's slow read had not finished: the names the router asks
 * Mistral for and the dated ids they covered. Used
 * only while no list has been read in this process; any list read replaces it, so a moved name is
 * still caught as soon as the list is readable. The production router deployment asks for
 * `mistral-medium-3-5`, so without that entry a fresh instance credits its first Medium answers to
 * it (CUR-4652).
 */
const SNAPSHOT: Readonly<Record<string, readonly string[]>> = {
	"mistral-medium-latest": ["mistral-medium-2604"],
	"mistral-medium-3-5": ["mistral-medium-2604"],
	"mistral-medium-3.5": ["mistral-medium-2604"],
};

let table: Map<string, Set<string>> | null = null;
let fetchedAt = 0;
let inflight: Promise<boolean> | null = null;

interface ModelEntry {
	id?: string;
	name?: string;
	aliases?: string[];
}

/** Every name La Plateforme accepts for a model, keyed by each of those names. */
function aliasTable(entries: ModelEntry[]): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const e of entries) {
		const names = new Set([e.id, e.name, ...(e.aliases ?? [])].filter((n): n is string => !!n));
		for (const n of names) out.set(n, names);
	}
	return out;
}

/**
 * Where the list can be read: the router's passthrough when chat's own lane is the router, then La
 * Plateforme. A per-ticket preview's lane is La Plateforme on the CI key, so its list comes from there
 * too, and the version check reads the same host its answers came from (CUR-3193).
 */
function listSources(): { source: string; url: string; apiKey: string }[] {
	const lane = mistralChatLane();
	const out: { source: string; url: string; apiKey: string }[] = [];
	if (lane.keyEnv === "MISTRAL_CHAT_API_KEY") {
		// On an instance whose lane is its own adapter, which forwards chat completions only, the list
		// comes from the router it forwards to (CUR-3841).
		const upstream = ((Reflect.get(config, "FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL") as string | undefined) ?? "").trim();
		const base = lane.baseURL.includes("/folkways-adapter/") && upstream ? upstream : lane.baseURL;
		const routerURL = base.replace(/\/+$/, "").replace(/\/v1$/, "");
		out.push({ source: "router", url: `${routerURL}/mistral/v1/models`, apiKey: lane.apiKey });
	}
	const plateforme = mistralPlateforme();
	if (plateforme) {
		out.push({ source: "plateforme", url: `${plateforme.baseURL}/models`, apiKey: plateforme.apiKey });
	}
	return out;
}

async function refresh(): Promise<boolean> {
	const sources = listSources();
	if (!sources.length) return false;
	const errors: string[] = [];
	for (const { source, url, apiKey } of sources) {
		try {
			const res = await fetch(url, {
				headers: { authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { data?: ModelEntry[] };
			// A 200 in another shape (a wrapped error, `{}`) is a failed read, so the next source is
			// tried and the last good table stays in use.
			if (!Array.isArray(body.data) || !body.data.length) throw new Error("no models listed");
			table = aliasTable(body.data);
			fetchedAt = Date.now();
			if (errors.length) logger.warn({ source, skipped: errors }, "[mistral] model list read from fallback");
			return true;
		} catch (err) {
			errors.push(`${source}: ${String(err)}`);
		}
	}
	// The last table read stays in use; with none, no version is claimed. Either way the next read
	// waits RETRY_AFTER_FAILURE_MS rather than delaying the next answer too.
	fetchedAt = Date.now() - TTL_MS + RETRY_AFTER_FAILURE_MS;
	// Warn, not error: the warm leg's `mistral:versions` probe is what alerts on an unreadable list
	// (CUR-3842), and an error line here also counted toward axiom-alert's server-errors (CUR-4358).
	logger.warn({ errors }, "[mistral] model list unreadable; answer versions unverified");
	return false;
}

/**
 * Reads the list now, for the warm leg that reports a failed read (CUR-3842). Null where no Mistral
 * lane is configured, so there is nothing to check. A good read also refreshes the table answers use.
 */
export async function probeMistralModelList(): Promise<boolean | null> {
	if (!listSources().length) return null;
	return refresh();
}

/**
 * Whether `upstream` (the name the router asked Mistral for, e.g. `openai/mistral-large-latest`) is
 * today an alias of `pinned` (e.g. `mistral-large-2512`). Undefined when the list could not be read.
 */
export async function isSameMistralModel(
	upstream: string,
	pinned: string
): Promise<boolean | undefined> {
	if (Date.now() - fetchedAt > TTL_MS) {
		inflight ??= refresh().finally(() => (inflight = null));
		// A stale table answers now; only a process with no table waits, and only briefly.
		if (!table) {
			await Promise.race([inflight, new Promise((r) => setTimeout(r, ANSWER_WAIT_MS))]);
		}
	}
	if (!table) {
		const covered = SNAPSHOT[upstream.replace(/^openai\//, "")];
		return covered ? covered.includes(pinned) : undefined;
	}
	const names = table.get(upstream.replace(/^openai\//, ""));
	return names ? names.has(pinned) : false;
}

/**
 * Our id for a model whose router name has no dated alias on La Plateforme, mapped to the name the
 * router asks Mistral for (CUR-3027). The staging router serves Large 4 (preview) as
 * `mistral-large-2610` and asks for `mistral-large-4` (x-litellm-model-name), while
 * Mistral's own list has no 2610 to look up. The preview's name claims no version, so this pairing is
 * the check.
 */
const ROUTER_UPSTREAM: Readonly<Record<string, string>> = {
	"mistral-large-2610": "mistral-large-4",
};

/** The name the router asks Mistral for when it serves `pinned`, where the alias list cannot say. */
export function routerUpstreamFor(pinned: string): string | undefined {
	return ROUTER_UPSTREAM[pinned.toLowerCase()];
}

/** Test seam: drop the cached list. */
export function resetMistralVersions(): void {
	table = null;
	fetchedAt = 0;
	inflight = null;
}
