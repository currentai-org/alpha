// Single source of truth for HOW and WHERE an answer is served — derived from
// config (the inference base URL + the served checkpoint), never hardcoded, so
// every provenance surface states what is ACTUALLY running and can't drift.
//
// identity.ts answers "WHO made the model"; this answers "WHO serves it and on
// what compute". The product's credibility rests on honest provenance: flip the
// serving host (e.g. HF router → CSCS direct) and the hero copy, the map header,
// the welcome modal, the map nodes, AND which compute cell lights per answer all
// update together — no surface can claim Swiss hardware while we're HF-served, or
// vice-versa.
//
// CLIENT-SAFE (pure, no $env / server imports): a `+layout.server.ts` resolves it
// from server config and ships only the derived labels (not the raw URL) to the
// client, where the map and greeting consume it.

import { resolveModelIdentity } from "./identity";
import { backendOrg, SWISS_BACKEND_HOSTS } from "./routing/catalog";

export type ServingProvenance = {
	/**
	 * Who we SEND the request to — a direct host ("HuggingFace") or, on a sovereign lane, the routing
	 * layer. NEVER the institution whose hardware ran the token: on a gateway lane that is decided
	 * per request and is not knowable here. See the sovereign branch of resolveServing (CUR-75).
	 */
	providerLabel: string;
	/** True when the lane lands on sovereign public compute rather than a prototype host. */
	isSovereign: boolean;
	/**
	 * True only when `isSovereign` AND the configured host is ITSELF one of the vetted
	 * single-institution SWISS_BACKEND_HOSTS — a direct connection, no gateway fan-out to a mix of
	 * backends. This is the ONE signal every "may this surface name Switzerland pre-answer" decision
	 * must read, rather than each surface re-deriving its own from `isSovereign` alone (which is what
	 * persona.ts's servingClause and grounding.ts's buildServingNote would otherwise each do independently;
	 * `isSovereign` is the imprecise one: true for the gateway even though it fans out to Featherless).
	 * `api-internal.publicai.co`, the only configured sovereign host, is not itself
	 * in SWISS_BACKEND_HOSTS, so this is `false` in production — and stays correct automatically
	 * if a direct Swiss lane is ever configured again (CSCS-direct, retired CUR-162). (CUR-1361)
	 */
	namesSwitzerland: boolean;
	/**
	 * Set only when the configured host is the model maker's own API (a `vendor` host), to the
	 * country it serves from. One destination, so the pre-answer copy may name the platform and country. (CUR-2274)
	 */
	directCountry?: string;
	/** The served checkpoint, e.g. "Apertus-70B-Instruct-2509". */
	servedCheckpoint: string;
	/** HF model page for the served checkpoint (best-effort). */
	checkpointUrl: string;

	// Prose — single source of truth. Each surface keeps its own lead-in and
	// renders the matching field below; both host variants are written here so
	// the copy stays honest in either mode.
	/** ChatIntroduction greeting: the clause after "Running on {brand}," — properties, never an institution. */
	computeTail: string;
	/** ChatIntroduction greeting: the serving sentence after "Running on {brand}…". */
	heroServingLine: string;
	/** StackMap "Under the hood" header paragraph. */
	mapHeaderLine: string;
	/** WelcomeModal serving sentence. */
	welcomeServingLine: string;

	// Map-node token replacements (the serving-dependent fragments of stack-map.json).
	/** router node: how provider routing is served right now. */
	routingProvider: string;
	/** cscs node: the parenthetical describing whether THIS prototype runs on CSCS yet. */
	cscsServingNote: string;
};


// `vendor` marks a host that is the model maker's own API, answering directly with no gateway or
// fan-out in between (CUR-2274: Mistral AI's La Plateforme for Mistral Large 3). Its copy names the
// maker's platform and country as fact, because the request cannot land anywhere else.
// `forwards`: a router that hands one maker's models unchanged to that maker's own API, keyed by
// ModelIdentity.maker, valued by the API's host. Those turns take the API's facts.
type HostFacts = {
	label: string;
	sovereign: boolean;
	vendor?: { country: string };
	forwards?: Record<string, string>;
};

// Static, non-sensitive hosts. router.huggingface.co = the HF prototype host (fast
// to stand up, but not sovereign). develop.aipotluck.org is our own
// proxy host on preview (CUR-1748) — without an entry here it falls through to the
// unknown-host branch below and renders the raw hostname as providerLabel, which
// reads as an internal deployment URL (CUR-1629).
const STATIC_HOSTS: Record<string, HostFacts> = {
	"router.huggingface.co": { label: "HuggingFace", sovereign: false },
	"develop.aipotluck.org": { label: "a preview environment", sovereign: false },
	// The staging deployment of that router, which the Mistral lane goes through. Its raw hostname on the
	// welcome reads as a staging build leaking into the UI (CUR-3573). It sends every Mistral model to
	// La Plateforme (api.mistral.ai), so those turns say Mistral in France, not "public compute"
	// (SOL-288).
	"router.stg.aipotluck.org": {
		label: "a staging router",
		sovereign: false,
		forwards: { "Mistral AI": "api.mistral.ai" },
	},
	"api.mistral.ai": { label: "Mistral AI's La Plateforme", sovereign: false, vendor: { country: "France" } },
};

// Sovereign serving hosts (served DIRECTLY on public supercompute, the production
// target) are CONFIG-DRIVEN, not hardcoded, so internal infra hostnames stay out of
// source. The server passes SOVEREIGN_HOSTS — a comma-separated `host=Label`
// list — from $env via the call sites below; every listed host is treated as sovereign.
// Unset (the default, and today's HF-served prototype) → no sovereign hosts, honest
// prototype-vs-production hedge copy.
export function parseSovereignHosts(spec?: string): Record<string, HostFacts> {
	const out: Record<string, HostFacts> = {};
	for (const pair of (spec ?? "").split(",")) {
		const [host, label] = pair.split("=").map((s) => s.trim());
		if (host) out[host] = { label: label || host, sovereign: true };
	}
	return out;
}

// Served checkpoints whose HF model page is PUBLIC — safe to deep-link from the
// "Open weights" control on the provenance map. Some served checkpoints — e.g.
// in-progress research builds served on CSCS — are unpublished and return 401 on
// huggingface.co, so linking them directly would 401 a public visitor and break
// the open-weights story. For anything not known-public we fall back to the SNAI (Swiss National
// AI Initiative) org page, which is always public and on-brand (the served checkpoint NAME still
// shows in the map copy, so we stay honest about exactly what's running).
// Keyed by the CANONICAL PUBLIC repo id (what identity.card resolves the served id to), NOT the wire
// id — 1.5's public card is swiss-ai/Apertus-v1.5-70B whatever org it serves under. LOWERCASED for
// lookup, valued by the casing to link.
//
// The lookup is case-insensitive because a wire id can change case without changing repo: the
// gateway serves 1.5 as `swiss-ai/apertus-v1.5-70b`, and identity.card carries that casing through
// (CUR-162). A case-sensitive miss is silent: the fallback is BY DESIGN identical for an unpublished
// checkpoint and for a public one we failed to recognise, so the downgrade looks exactly like the
// feature working.
//
// On huggingface.co, Apertus-v1.5-70B and apertus-v1.5-70b both answer 200 (HF is case-insensitive on
// repo names), Apertus-70B-Instruct-2509 200, and apertus-70b-instruct 401. That last one is the
// gateway's ROUTING-GROUP alias, not a repo, so the org-page fallback is the right answer for it and
// the map below is deliberately not widened to cover it. We emit the canonical casing rather than the
// wire casing: HF's tolerance is not a contract, and the canonical form is what was checked.
const PUBLIC_MODEL_PAGES = new Map(
	[
		"swiss-ai/Apertus-70B-Instruct-2509",
		"swiss-ai/Apertus-8B-Instruct-2509",
		"swiss-ai/Apertus-v1.5-70B",
		// Public and ungated (CUR-2274).
		"mistralai/Mistral-Large-3-675B-Instruct-2512",
		// Public and ungated (CUR-2460).
		"mistralai/Mistral-Medium-3.5-128B",
		// Public and ungated (CUR-2716).
		"mistralai/Mistral-Small-4-119B-2603",
		// Public (CUR-3913): GLM ungated, Bielik behind the same click-through as Apertus. ALIA's
		// served BSC-LT/ALIA-40b-instruct answers 401, so it is left off.
		"zai-org/GLM-5.2",
		"speakleash/Bielik-11B-v3.0-Instruct",
		// 200 and ungated (CUR-3864). It is in the picker, and without this entry its X-ray row names
		// the model with nothing to check it against.
		"aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B",
	].map(
		(id) => [id.toLowerCase(), id] as const
	)
);
const SWISSAI_ORG_URL = "https://huggingface.co/swiss-ai";

// Which backends we can name, and which of them are Swiss, are both read from the catalog's one host
// table (`BACKEND_HOSTS`, routing/catalog.ts, CUR-4587). Swiss is the host's org region, never the
// fact that a host has a name: naming a backend and claiming it Swiss were once the same edit, and
// that would have called api.featherless.ai and api.sea-lion.ai Swiss (CUR-996).
//
// The sovereign lane's gateway, api-internal.publicai.co, is our own routing infrastructure and stays
// in config, out of the table. endpointOai warns on every response that lands outside the Swiss set.

/** The Swiss hosts as data. `servedBackends.spec.ts` pins the set and the generated copy that
 *  verify-served-backends.mjs reads, since that script reads persisted answers and cannot import TS. */
export const swissBackendHosts = (): string[] => [...SWISS_BACKEND_HOSTS];

/**
 * Name the institution behind a measured backend base URL, for the PER-ANSWER surfaces that have one
 * (the provenance badge, the envelope). `undefined` for a backend we've never vetted at all — which
 * prints nothing rather than guessing. A vetted-but-not-Swiss backend (Featherless, AI Singapore)
 * still gets a name: silence is only honest for the truly unknown, not for "known and not Swiss".
 */
export function backendDisplay(backendBaseURL?: string): string | undefined {
	return backendOrg(hostOf(backendBaseURL))?.label;
}

/** The host of a measured backend base URL, "" when there isn't one. For callers that key their own
 *  table off it — reveal.ts maps it to a stack-map node — so URL parsing stays in one place. */
export function backendHost(backendBaseURL?: string): string {
	return hostOf(backendBaseURL);
}

const OPENROUTER_HOST = "openrouter.ai";

/**
 * Where OpenRouter sends a request, by the `provider` name each of its chunks carries ("Mistral" on
 * the staging router's Large 4 copy), as the host BACKEND_HOSTS knows that provider by. A
 * name not listed here gets no compute host.
 */
const OPENROUTER_PROVIDER_HOSTS: Readonly<Record<string, string>> = {
	mistral: "https://api.mistral.ai/v1",
};

/**
 * A router answer that came through OpenRouter, recorded as where it ran: the provider OpenRouter
 * named as the backend, and OpenRouter as who served it. Undefined for any other backend. An
 * unlisted provider keeps OpenRouter as the backend, so no compute is claimed for it.
 */
export function throughOpenRouter(
	backendBaseURL: string,
	bodyProvider: string | undefined
): { backend: string; provider: string } | undefined {
	if (hostOf(backendBaseURL) !== OPENROUTER_HOST) return undefined;
	const named = bodyProvider ? OPENROUTER_PROVIDER_HOSTS[bodyProvider.trim().toLowerCase()] : undefined;
	return { backend: named ?? backendBaseURL, provider: "openrouter" };
}

/** The maker's own platform when the host a turn was SENT to (`routerMetadata.lane`, a bare host,
 *  CUR-3193) is a direct vendor API (CUR-2287: the X-Ray panel shows no gateway rows for an answer that never
 *  passed through one). `backend` alone cannot say this: a router that forwards to the
 *  vendor records the vendor's host as the backend too, so a router.stg turn would read as direct
 *  (CUR-4577). Unset lane (turns persisted before CUR-3193) is not a reading, so not direct. */
export function laneVendor(lane?: string): { label: string; country: string } | undefined {
	const host = lane?.includes("://") ? hostOf(lane) : lane?.trim();
	const facts = host ? STATIC_HOSTS[host] : undefined;
	return facts?.vendor ? { label: facts.label, country: facts.vendor.country } : undefined;
}

/** The served model's public Hugging Face card, or undefined when it is not on the known-public list. */
export function publicModelPage(servedModelId?: string): string | undefined {
	const publicRepo = servedModelId
		? (resolveModelIdentity(servedModelId).card ?? servedModelId)
		: undefined;
	const canonicalRepo = publicRepo ? PUBLIC_MODEL_PAGES.get(publicRepo.toLowerCase()) : undefined;
	return canonicalRepo ? `https://huggingface.co/${canonicalRepo}` : undefined;
}

/**
 * Does a LiteLLM `x-litellm-model-api-base` name a backend inside Switzerland? This is the only
 * measurement that can falsify the "sovereign public compute in Switzerland" copy — the pre-turn
 * layout resolve cannot, because the gateway picks per request.
 */
export function backendIsSwiss(backendBaseURL?: string): boolean {
	return !!backendOrg(hostOf(backendBaseURL))?.swiss;
}

/**
 * Is the shipped "sovereign public compute in Switzerland" copy FALSE for this call?
 *
 * A non-Swiss backend is not on its own enough, and that is the whole reason this predicate exists
 * rather than a bare `!backendIsSwiss(backend)` at the log site. The copy is a claim about the
 * compute that wrote the USER'S ANSWER. The same OpenAI client also carries every side-call —
 * conversation titles, the search-trigger decision, the query rewrite, the world-model verifier, and
 * the second-opinion panel, which fans out to EuroLLM and Olmo deliberately *because* they are not
 * models Public AI hosts. Those land on `api-internal-intel.publicai.co`, outside the allowlist, and
 * they falsify nothing: the answer still came from Switzerland.
 *
 * Without this distinction, every side-call to `api-internal-intel.publicai.co/{olmo,eurollm}/v1`
 * would log "the sovereign-compute copy is false for this turn" about a turn whose answer came from
 * CSCS. Those calls stay away only while SECOND_OPINION_MODEL is pinned off "auto", so the false
 * positive is dormant, not fixed.
 *
 * `servesUserAnswer` is therefore required, not optional and not defaulted: the caller has to say
 * which kind of call this is, because a default would silently pick a side and the wrong default
 * here is exactly the false positive above.
 */
export function sovereignCopyFalsifiedBy(call: {
	backend?: string;
	servesUserAnswer: boolean;
}): boolean {
	return call.servesUserAnswer && !!call.backend && !backendIsSwiss(call.backend);
}

// The Folkways adapter's Mistral route, in front of chat's Mistral lane. It forwards each
// request unchanged to its upstream, La Plateforme unless FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL says
// otherwise, so the serving facts are La Plateforme's. Without this, pointing MISTRAL_CHAT_BASE_URL at
// the route renders the app's own hostname as the provider and drops the vendor country. (CUR-3186)
const FOLKWAYS_MISTRAL_PATH = "/folkways-adapter/mistral/v1";
const FOLKWAYS_MISTRAL_UPSTREAM_HOST = "api.mistral.ai";

function hostOf(baseURL?: string): string {
	try {
		if (!baseURL) return "";
		const url = new URL(baseURL);
		if (url.pathname.replace(/\/+$/, "").endsWith(FOLKWAYS_MISTRAL_PATH)) return FOLKWAYS_MISTRAL_UPSTREAM_HOST;
		return url.host;
	} catch {
		return "";
	}
}

/**
 * The base URL this model's requests actually go to (CUR-2274). A model configured with its own
 * OpenAI-compatible endpoint (a direct vendor API such as Mistral's) goes there; every catalog model's
 * first endpoint already carries the shared OPENAI_BASE_URL, so for those this changes nothing. An
 * agent-type endpoint is not an inference host, so it keeps the deployment's fallback.
 *
 * A base URL on the Folkways adapter's gateway route is the app's own host, which forwards
 * every request unchanged to `FOLKWAYS_UPSTREAM_BASE_URL`. The serving facts are that upstream's, so
 * pass the deployment's value as `adapterUpstream` (unset, the adapter's own default, HF's router).
 * Without it the welcome line reads "served via <the deployment's own host>". (CUR-3573)
 */
export function baseURLForModel(
	model: { endpoints?: ReadonlyArray<{ type: string; baseURL?: string }> } | undefined,
	fallback?: string,
	adapterUpstream?: string
): string | undefined {
	const first = model?.endpoints?.[0];
	const base = first?.type === "openai" && first.baseURL ? first.baseURL : fallback;
	return isFolkwaysGateway(base) ? adapterUpstream?.trim() || FOLKWAYS_DEFAULT_UPSTREAM : base;
}

const FOLKWAYS_GATEWAY_PATH = "/folkways-adapter/v1";
// The adapter's own default when FOLKWAYS_UPSTREAM_BASE_URL is unset (routes/folkways-adapter/observe.ts).
const FOLKWAYS_DEFAULT_UPSTREAM = "https://router.huggingface.co/v1";

function isFolkwaysGateway(baseURL?: string): boolean {
	try {
		return !!baseURL && new URL(baseURL).pathname.replace(/\/+$/, "").endsWith(FOLKWAYS_GATEWAY_PATH);
	} catch {
		return false;
	}
}

export function resolveServing(
	baseURL?: string,
	servedModelId?: string,
	sovereignHostsSpec?: string
): ServingProvenance {
	const laneHost = hostOf(baseURL);
	const host =
		STATIC_HOSTS[laneHost]?.forwards?.[resolveModelIdentity(servedModelId).maker] ?? laneHost;
	const known = STATIC_HOSTS[host] ?? parseSovereignHosts(sovereignHostsSpec)[host];
	const providerLabel = known?.label ?? (host || "the configured endpoint");
	const isSovereign = known?.sovereign ?? false;

	const servedCheckpoint = servedModelId?.split("/").pop() || "the configured model";
	// Resolve the served id to its canonical PUBLIC repo before deep-linking. Apertus serves on the wire
	// under a gated pre-release org (apertus-ai/…, a 401 for the public); identity.card carries the mapping
	// to the released swiss-ai/… weights. Then gate on the known-public allowlist so an UNPUBLISHED
	// checkpoint (research build served on CSCS) still falls back to the SNAI org page instead of 401'ing.
	const checkpointUrl = publicModelPage(servedModelId) ?? SWISSAI_ORG_URL;

	if (known?.vendor) {
		// The maker's own API. One destination, so naming the platform and its country before
		// the answer is true by construction; the badge's measured backend says the same thing after.
		// Nothing here says sovereign or public compute: La Plateforme is a company's commercial service. (CUR-2274)
		const where = `${providerLabel} in ${known.vendor.country}`;
		return {
			providerLabel,
			isSovereign,
			namesSwitzerland: false,
			directCountry: known.vendor.country,
			servedCheckpoint,
			checkpointUrl,
			computeTail: `served directly by ${where}.`,
			heroServingLine: `This prototype is served directly by ${where}.`,
			mapHeaderLine: `The open source stack behind this answer — live components, and the gaps still open.`,
			welcomeServingLine: `This prototype is served directly by ${where}.`,
			routingProvider: `not used for this model (served directly by ${providerLabel})`,
			cscsServingNote: `this prototype's current model is served by ${where}, not from CSCS`,
		};
	}

	if (isSovereign) {
		// A sovereign lane is a ROUTING lane, and the compute behind it is chosen per request. So the
		// copy describes the compute by its PROPERTIES and names no institution (CUR-75).
		//
		// Naming one from the config label is wrong on a measurable share of turns: in one week of
		// production the `swiss-ai/apertus-70b-instruct` routing group answered from CSCS 293 times and
		// from another backend 43 times (13%). `providerLabel` is therefore FIXED here rather than read
		// from the config entry, whose label is vestigial for sovereign lanes: the entry's one job is
		// declaring that this host's lane is sovereign. The copy also never says "not a company", since a
		// backend behind the gateway can be one.
		const routingLabel = "the Public AI Inference Utility";

		// `isSovereign` only says the configured host is a ROUTING lane, not which backend answers: that
		// lane can route every real answer to Featherless (a US host), and this branch runs pre-answer,
		// before any backend is chosen (CUR-1361). `backendIsSwiss()` and `sovereignCopyFalsifiedBy()`
		// read the per-answer measured backend and feed the provenance badge and endpointOai's retry.
		//
		// A live per-request measurement is too costly here: resolveServing() runs in loadChatShellData
		// on every /chat/* page load, and the only measured-backend read (verify-served-backends.mjs)
		// is a LATERAL jsonb_array_elements over the whole conversations table with no index on the
		// JSONB createdAt path, fine as a periodic CI job but not as page-load cost. Instead: a lane
		// whose CONFIGURED host is itself one of the vetted single-institution
		// SWISS_BACKEND_HOSTS (a direct CSCS/Infomaniak connection, no gateway fan-out) still makes the
		// specific claim truthfully, by construction — that's the ONLY shape under which the pre-answer
		// hero/welcome copy can name Switzerland without a per-answer measurement. `api-internal.publicai.co`
		// (today's only configured sovereign host) is not itself in that set — it fans out to a mix of
		// backends chosen per request — so today this branch always takes the non-specific path below.
		if (backendIsSwiss(baseURL)) {
			// The per-answer backend IS knowable and is the surface allowed to be specific: it arrives on
			// `x-litellm-model-api-base`, is persisted as routerMetadata.backend, and reaches the
			// provenance envelope. backendIsSwiss() above is what makes THIS branch's claim falsifiable —
			// a direct single-backend connection cannot silently be answered by a different institution.
			return {
				providerLabel: routingLabel,
				isSovereign,
				namesSwitzerland: true,
				servedCheckpoint,
				checkpointUrl,
				computeTail: `served on sovereign public compute in Switzerland.`,
				heroServingLine: `This prototype runs on sovereign public compute in Switzerland, routed by ${routingLabel}.`,
				mapHeaderLine: `The open source stack behind this answer — live components, and the gaps still open.`,
				welcomeServingLine: `This prototype is served on sovereign public compute in Switzerland, via ${routingLabel}.`,
				routingProvider: `live (OpenAI-compatible serving, routed per request across sovereign Swiss backends)`,
				cscsServingNote: "and is one of the Swiss backends serving this prototype",
			};
		}

		// Placeholder wording (CUR-1361), pending final copy. Honest about the lane's INTENT (it is
		// genuinely Public AI's own sovereign routing infrastructure) without naming a country the
		// gateway cannot guarantee per answer. The provenance badge carries the specific, per-answer
		// truth (Switzerland or not) from the measured backend — this copy no longer duplicates that
		// claim ahead of when it's knowable.
		return {
			providerLabel: routingLabel,
			isSovereign,
			namesSwitzerland: false,
			servedCheckpoint,
			checkpointUrl,
			computeTail: `served by ${routingLabel}'s sovereign infrastructure.`,
			heroServingLine: `This prototype runs on ${routingLabel}'s sovereign infrastructure.`,
			mapHeaderLine: `The open source stack behind this answer — live components, and the gaps still open.`,
			welcomeServingLine: `This prototype is served on ${routingLabel}'s sovereign infrastructure.`,
			routingProvider: `live (OpenAI-compatible serving, routed per request across ${routingLabel}'s sovereign infrastructure)`,
			cscsServingNote: "and is one of the backends this prototype's routing lane can reach",
		};
	}

	// Prototype host (HuggingFace or unknown): honest prototype-vs-production hedge. Naming the host
	// IS correct here — this lane talks to it directly, and nothing claims it as sovereign compute.
	return {
		providerLabel,
		isSovereign,
		namesSwitzerland: false,
		servedCheckpoint,
		checkpointUrl,
		computeTail: `served via ${providerLabel}, hosted on public compute.`,
		heroServingLine: `This prototype is served via ${providerLabel}; the production stack runs on sovereign public compute. Not a company.`,
		mapHeaderLine: `The open source stack behind this answer — live components, and the gaps still open.`,
		welcomeServingLine: `This prototype is served via ${providerLabel} Inference and the Public AI Inference Utility; the production stack is being built on sovereign public compute at CSCS (Switzerland).`,
		routingProvider: `already live via ${providerLabel}`,
		cscsServingNote: `this prototype is served via ${providerLabel}, not yet from CSCS`,
	};
}
