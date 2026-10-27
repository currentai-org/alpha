// Single source of truth for "what model is actually serving this answer."
//
// The whole product's credibility rests on honest provenance, so the model
// name must NEVER be hardcoded in places that can drift. Everything user-facing
// (system prompt, provenance badge, model identity surfaces) derives from the
// served model id. Flip the served model — e.g. when a newer Apertus checkpoint
// lands — and every surface updates with zero code change and no risk of the UI
// claiming a model that isn't running.
//
// This module is CLIENT-SAFE (pure, no $env / server imports), so the provenance
// badge can resolve identity from `message.routerMetadata.model` in the browser.
// persona.ts (server) imports resolveModelIdentity from here so the prompt and
// the badge can never disagree about who made the model.

import { catalogByGatewayId, orgs } from "./routing/catalog";

export type ModelIdentity = {
	short: string; // display headline — version brand + served size, e.g. "Apertus 70B"
	served?: string; // the actual served checkpoint, e.g. "Apertus-70B-Instruct-2509" — technical detail
	maker: string; // "the Swiss National AI Institute (SNAI)" — Institute; see SWISSAI below
	makerShort: string; // "SNAI"
	openness: string; // "fully open" | "open weights"
	training: string; // openness fact injected into the prompt; "" for unknown models
	// Canonical PUBLIC HF repo id ("org/model") for the model card + maker links, when it must NOT be
	// derived from the served/wire id. Apertus is served on the wire under a pre-release org
	// ("apertus-ai/…", a gated 401 for the public) while the released weights live under swiss-ai — so the
	// badge links here instead of at the org the request happened to route through. Undefined ⇒ the badge
	// falls back to deriving the link from the served id (correct whenever wire org == public org).
	card?: string;
};

// "Institute", not "Initiative". Taken verbatim from the Apertus model card's acceptable-use
// agreement: "The Swiss National AI Institute (SNAI) is a partnership between the two Swiss Federal
// Institutes of Technology, ETH Zurich and EPFL." The acronym is identical either way, so a wrong noun
// goes unnoticed — and this string is what the model says about ITSELF on "who made you",
// the first question a new user asks. Change it only against the card, not from memory (CUR-152).
const SWISSAI = "the Swiss National AI Institute (SNAI)";

// Apertus is one of the few FULLY-open models — open weights, open training
// recipe, AND openly-published training data (verified against the model card +
// technical report). A plain FACT, meant to be spliced directly into a sentence —
// persona.ts derives the matching "say this honestly" instruction separately
// (see fillIdentityTokens' trainingReminder), so the model is never shown raw
// instruction text as if it were something to say.
//
// Keep instructions out of this string: it is spliced mid-sentence into both
// persona.ts's honesty clause AND a "You:" few-shot example, and a model given
// instruction text in that position may echo it verbatim on a tangential query.
const APERTUS_TRAINING =
	"weights, training recipe, and training data are all openly published — one of the few fully-open models by that measure";

// Parameter size (e.g. "8B", "70B") read straight from the served checkpoint id, so the headline
// names the model that's actually running. Drift-proof by construction — flip the served model and
// the size updates itself. Empty for historical messages with no captured id (falls back to the
// bare version brand).
function sizeSuffix(served?: string): string {
	const m = served?.match(/(\d+(?:\.\d+)?)b\b/i);
	return m ? ` ${m[1]}B` : "";
}

// Version brand (the decimal in a checkpoint id) read from the served checkpoint, NOT hardcoded — so
// flipping the served model carries the brand with it and no surface can claim a version that isn't
// running. A decimal-versioned id like "Apertus-X.Y-8B-…" → " X.Y"; the 2509 release
// "Apertus-70B-Instruct-2509" has no decimal version in its id → "" (renders the plain "Apertus 70B"
// brand). This is the drift-proof replacement for a hardcoded brand: the alpha runs on the
// officially-released Apertus-70B-Instruct-2509, and will adopt a newer Apertus checkpoint once SNAI
// releases one — at which point flipping MODEL_ALLOWLIST to it updates the headline with zero code change.
function versionSuffix(served?: string): string {
	// `v?` is load-bearing: SNAI ships the 1.5 checkpoint as "Apertus-v1.5-70B", and without it the "v"
	// between the dash and the digits defeats the match → 1.5 would render as the bare "Apertus 70B".
	const m = served?.match(/apertus[-\s]?v?(\d+\.\d+)/i);
	return m ? ` ${m[1]}` : "";
}

// The gateway serves a reasoning variant of a checkpoint under its own id (`…-70b-thinking`). Without
// this the two read as the same model in the picker (CUR-1683).
function variantSuffix(served?: string): string {
	return /-thinking$/i.test(served ?? "") ? " Thinking" : "";
}

function apertus(served?: string): ModelIdentity {
	return {
		short: `Apertus${versionSuffix(served)}${sizeSuffix(served)}${variantSuffix(served)}`,
		served,
		maker: SWISSAI,
		makerShort: "SNAI",
		openness: "fully open",
		training: APERTUS_TRAINING,
		// Pin the public card to swiss-ai regardless of the wire org: the 2509 default already serves as
		// swiss-ai/… (so this is a no-op there), but 1.5 serves as apertus-ai/… (gated 401) while its
		// weights are public at swiss-ai/Apertus-v1.5-70B. `served` is the bare checkpoint name.
		// No public card for the thinking variant: swiss-ai/apertus-v1.5-70b-thinking answers 401,
		// so it links nowhere rather than to a dead page.
		card: served && !variantSuffix(served) ? `swiss-ai/${served}` : undefined,
	};
}

// Per-user local (LAN/self-hosted) endpoints stamp an internal id shaped
// `local:{endpointId}:{servedModelId}` (localModels.ts's LOCAL_MODEL_ID_PREFIX/LOCAL_ENDPOINT_ID_LENGTH
// — that module is server-only/db-backed and cannot be imported here, this file must stay pure per its
// own header, so the shape is duplicated; keep both in sync if it ever changes). Whenever a real
// measurement is available (routerMetadata.model, seeded with the endpoint's own label — see
// endpointOai.ts's routerModel param), a caller never reaches this at all. This is the FLOOR: the
// brief pre-first-byte window (a cold local model can take real seconds to start responding) where
// `rawId` is the raw conversation model id with nothing richer known yet. Stripping the prefix here
// is what keeps that window showing "llama3.2:latest" rather than "local:<endpointId>:
// llama3.2:latest"; the internal id is not meant to be read by a person.
const LOCAL_MODEL_ID_PREFIX = "local:";
const LOCAL_ENDPOINT_ID_LENGTH = 24;

function stripLocalIdPrefix(rawId: string): string {
	if (!rawId.startsWith(LOCAL_MODEL_ID_PREFIX)) return rawId;
	const rest = rawId.slice(LOCAL_MODEL_ID_PREFIX.length);
	if (rest.length <= LOCAL_ENDPOINT_ID_LENGTH || rest[LOCAL_ENDPOINT_ID_LENGTH] !== ":") return rawId;
	const endpointId = rest.slice(0, LOCAL_ENDPOINT_ID_LENGTH);
	if (!/^[0-9a-f]{24}$/.test(endpointId)) return rawId;
	return rest.slice(LOCAL_ENDPOINT_ID_LENGTH + 1);
}

/** Is this a per-user local (LAN/self-hosted) model id? The one thing callers outside this module
 *  need to know without re-parsing the shape themselves — e.g. ChatIntroduction's empty-state greeting,
 *  which must not claim "sovereign public compute in Switzerland" for a model that never left the
 *  user's own network. A bare prefix check (not the full stripLocalIdPrefix parse) is enough here: the
 *  question is only "is this local at all", not "what's the served tag". */
export function isLocalModelId(id?: string): boolean {
	return !!id?.startsWith(LOCAL_MODEL_ID_PREFIX);
}

// Ollama's shorthand for pulling a GGUF straight from a Hugging Face repo is
// `hf.co/<owner>/<repo name>[:<quantization tag>]` -- long enough on its own to clip in a picker
// list, and doubly so once CUR-1262's own `{endpointLabel}:{servedModelId}` display-name prefix
// sits in front of it. The owner segment carries no information a person picking a model needs;
// this drops exactly that segment (wherever it appears in the string) and leaves everything else,
// including the quantization tag, untouched.
const HF_OWNER_SEGMENT = /hf\.co\/[^/]+\//i;

/** A local model's display name, shortened for a picker list. Catalog model names never match
 *  `HF_OWNER_SEGMENT`, so this only ever changes something for a local model -- but callers still
 *  gate on `isLocalModelId` explicitly, so the trim is visibly scoped to local models at each call
 *  site rather than an incidental side effect of the regex never matching anything else. */
export function pickerDisplayName(model: { id: string; displayName: string }): string {
	return isLocalModelId(model.id) ? model.displayName.replace(HF_OWNER_SEGMENT, "") : model.displayName;
}

// Canonical display-name policy: the headline shows the version brand
// AND the served parameter size — e.g. "Apertus 70B" — derived from the served checkpoint. The
// differentiator here is radical honesty, and an open model doing this well is the story, not a
// liability; hiding the size would be the kind of obscuring the product rejects. The full served
// checkpoint (e.g. Apertus-70B-Instruct-2509) is still carried in `served` and surfaced
// to technical users — badge tooltip, the map node's HF link, a persona precision note.
export function resolveModelIdentity(rawId?: string): ModelIdentity {
	const normalizedId = rawId ? stripLocalIdPrefix(rawId) : rawId;
	const lo = (normalizedId ?? "").toLowerCase();
	const served = normalizedId?.split("/").pop() || undefined;

	if (lo.includes("apertus")) {
		return apertus(served);
	}

	// Mistral Large 3, served by Mistral AI's own API as `mistral-large-2512` (CUR-2274). The wire id has no
	// org and no size, so the headline and the card are pinned rather than derived from it. On
	// huggingface.co, mistralai/Mistral-Large-3-675B-Instruct-2512 is public and ungated,
	// license apache-2.0. Open weights, not fully open: the training data is not published.
	if (lo.includes("mistral-large-2512") || lo.includes("mistral-large-3")) {
		return {
			short: "Mistral Large 3",
			served,
			maker: "Mistral AI",
			makerShort: "Mistral AI",
			openness: "open weights",
			training: "",
			card: "mistralai/Mistral-Large-3-675B-Instruct-2512",
		};
	}

	// Mistral Large 4, in public preview (CUR-3027). The staging router serves it as
	// `mistral-large-2610` and asks Mistral for `mistral-large-4`. Until the weights are on Hugging Face, no openness or
	// card is claimed.
	if (lo.includes("mistral-large-2610") || lo.includes("mistral-large-4")) {
		return {
			short: "Mistral Large 4",
			served,
			maker: "Mistral AI",
			makerShort: "Mistral AI",
			openness: "",
			training: "",
		};
	}

	// Mistral Small 4, served as `mistral-small-2603`: the side-call model, and the default on per-ticket
	// previews (CUR-2716). mistralai/Mistral-Small-4-119B-2603 is public,
	// ungated, license apache-2.0.
	if (lo.includes("mistral-small-2603") || lo.includes("mistral-small-4")) {
		return {
			short: "Mistral Small 4",
			served,
			maker: "Mistral AI",
			makerShort: "Mistral AI",
			openness: "open weights",
			training: "",
			card: "mistralai/Mistral-Small-4-119B-2603",
		};
	}

	// Mistral Medium 3.5, the direct lane's backup (CUR-2460), served as `mistral-medium-2604`; Mistral's
	// /v1/models lists `mistral-medium-3.5` among that id's aliases. mistralai/Mistral-Medium-3.5-128B is public,
	// ungated, license "other" with no name given.
	if (lo.includes("mistral-medium-2604") || lo.includes("mistral-medium-3")) {
		return {
			short: "Mistral Medium 3.5",
			served,
			maker: "Mistral AI",
			makerShort: "Mistral AI",
			openness: "open weights",
			training: "",
			card: "mistralai/Mistral-Medium-3.5-128B",
		};
	}

	// `mistral-large-latest` and its siblings: the name the staging router asks Mistral for (CUR-2928),
	// recorded when the dated version behind it was not confirmed as ours. The maker is certain and the
	// checkpoint is not, so no openness or card is claimed, and the answer does not read as a backup.
	const latest = lo.match(/mistral-(large|medium|small)-latest/);
	if (latest) {
		return {
			short: `Mistral ${latest[1][0].toUpperCase()}${latest[1].slice(1)} (latest)`,
			served,
			maker: "Mistral AI",
			makerShort: "Mistral AI",
			openness: "",
			training: "",
		};
	}

	// GLM (Z.ai / Zhipu AI) — the configured cross-model backup lane (FALLBACK_MODEL_ID). Identity is
	// still resolved from the served id (name/version derive from it), this branch only adds the maker
	// we can vouch for. Open weights, not fully open (training data unpublished) — no training claim.
	if (lo.includes("glm")) {
		const pretty = (served ?? normalizedId ?? "GLM").replace(/[-_]/g, " ").trim();
		return {
			short: pretty,
			served,
			maker: "Z.ai (Zhipu AI)",
			makerShort: "Z.ai",
			openness: "open weights",
			training: "",
		};
	}

	// SEA-LION (AI Singapore). Every `aisingapore/` id is theirs, so the maker is certain; the name stays
	// the catalog's. Without this the persona says "an open source community" instead of naming the maker.
	if (lo.startsWith("aisingapore/") || lo.includes("sea-lion")) {
		const pretty = catalogByGatewayId(normalizedId)?.name ?? (served ?? normalizedId ?? "SEA-LION").replace(/[-_]/g, " ").trim();
		return {
			short: pretty,
			served,
			maker: "AI Singapore",
			makerShort: "AI Singapore",
			openness: "open weights",
			training: "",
		};
	}

	// Gemma (Google) and Qwen (Alibaba) sit on the second-opinion panel only, so no catalog entry names
	// them; without these the panel's takes were headed by the checkpoint, "gemma-4-31B-it" (CUR-2203).
	if (lo.startsWith("google/gemma-")) {
		const m = /^gemma-(\d+(?:\.\d+)?)-(\d+B)/i.exec(served ?? "");
		return {
			short: m ? `Gemma ${m[1]} ${m[2]}` : "Gemma",
			served,
			maker: "Google",
			makerShort: "Google",
			openness: "open weights",
			training: "",
		};
	}
	if (lo.startsWith("qwen/qwen")) {
		const m = /^qwen(\d+(?:\.\d+)?)-(\d+B)/i.exec(served ?? "");
		return {
			short: m ? `Qwen ${m[1]} ${m[2]}` : "Qwen",
			served,
			maker: "Alibaba (Qwen team)",
			makerShort: "Alibaba",
			openness: "open weights",
			training: "",
		};
	}

	// ALIA (Barcelona Supercomputing Center). The article and acronym follow the SNAI line above, so the
	// persona reads "developed by the Barcelona Supercomputing Center (BSC)". The generic
	// branch below names "an open source community", which ALIA must not repeat as its maker (CUR-3836).
	if (lo.includes("alia-40b") || lo.startsWith("bsc-lt/")) {
		return {
			short: catalogByGatewayId(normalizedId)?.name ?? "ALIA 40B",
			served,
			maker: "the Barcelona Supercomputing Center (BSC)",
			makerShort: "BSC",
			openness: "open weights",
			training: "",
		};
	}

	// Generic fallback: a readable name from the id without a training-data story we can't vouch for. A
	// model in the routing catalog keeps the catalog's name, which is the one the picker shows, so the
	// landing line and the picker agree, and the catalog's maker, which is the one the answer footer
	// credits (Bielik → SpeakLeash, CUR-3836). Only a model the catalog doesn't know gets the generic maker.
	// An HF-routed id can carry its provider pin ("…-Instruct:plgrid", hfProviderPin.ts); the catalog
	// lists the bare checkpoint.
	const entry = catalogByGatewayId(normalizedId) ?? catalogByGatewayId(normalizedId?.replace(/:[^/:]*$/, ""));
	if (entry) {
		return {
			short: entry.name,
			served,
			maker: orgs[entry.maker].name,
			makerShort: orgs[entry.maker].name,
			openness: "open weights",
			training: "",
		};
	}
	const pretty = (served ?? normalizedId ?? "an open model")
			.replace(/-instruct.*$/i, "")
			.replace(/[-_]/g, " ")
			.trim();
	return {
		short: pretty,
		served,
		maker: "an open source community",
		makerShort: "open source",
		openness: "open weights",
		training: "",
	};
}

// Friendly names for known HF inference providers (the raw header value is a
// slug). Public AI is the sovereign-inference provider serving Apertus here.
// "local" (CUR-1194) is the venue tag endpointOai.ts's routerProvider param stamps for a per-user LAN
// endpoint — without this entry it would fall through to the "Public AI" default below, which is
// correct for every gateway-routed lane but false for a turn that never left the user's own network.
const PROVIDER_NAMES: Record<string, string> = {
	publicai: "Public AI",
	local: "Local",
	// The routerProvider the Mistral lane stamps. It names the lane, not the host: the staging router
	// serves Mistral Medium 3.5 from Scaleway too, so the recorded backend says where it ran (CUR-4347). (CUR-2274)
	mistral: "Mistral AI",
	openrouter: "OpenRouter",
};

// The model id the provenance badge should show (CUR-125). `routerMetadata.model` is the only
// VERIFIED override — a router hop or a cross-model backup lane reporting what actually served,
// which beats the request. Its absence is not evidence nothing served: the primary CSCS/gateway lane
// reports its serving backend (`.backend`) on every healthy turn and never sends a model-override
// header, because there is nothing to override. Gating the badge on `.model` alone would suppress it
// on that ordinary, correctly-served case. So fall back to the requested model id whenever ANY router
// signal came back (`.backend` or `.provider`) — proof a real response returned through an identifiable
// path, so the requested model is what answered. Only routerMetadata being entirely absent — the
// "no idea what served this" case (CUR-113) — suppresses the badge.
export function servedModelId(
	routerMetadata: { model?: string; provider?: string; backend?: string } | undefined,
	requestedModelId: string | undefined
): string | undefined {
	if (routerMetadata?.model) return routerMetadata.model;
	if (routerMetadata?.provider || routerMetadata?.backend) return requestedModelId;
	return undefined;
}

// Whether a failover lane answered instead of the conversation's model, so the badge can say
// "(backup)". Derived, never hardcoded to a model: the served id differs from the requested one.
// `:provider` pin suffixes are stripped first (the same checkpoint through a pinned lane is not a
// backup), a router (Omni) serve always differs by design and carries `route`, and a same-maker
// substitution is an intended swap (Apertus 1.5, CUR-127), so only a cross-maker stand-in counts.
// A stored failover record (CUR-2239) settles it outright: it is written only when the primary did not
// answer and another model did, which is a backup whatever the makers, as with Apertus 70B covered by
// the gateway's Infomaniak Apertus group (CUR-2293).
// Shared by the chat badge and the data export (CUR-1836), so the two cannot word it differently.
export function servedByBackup(
	routerMetadata:
		| { model?: string; route?: string; assistedBy?: readonly { role: string; model: string }[] }
		| undefined,
	requestedModelId: string | undefined,
	failover?: { to?: string }
): boolean {
	if (failover?.to) return true;
	const base = (id: string) => id.split(":")[0];
	// The arithmetic route hands the turn to the planner's model on purpose (CUR-3316), so the model
	// it names wrote the answer by design, and no lane failed.
	const key = (id: string) => base(id.toLowerCase()).split("/").pop();
	const served = routerMetadata?.model;
	if (served && routerMetadata?.assistedBy?.some((e) => e.role === "math-route" && key(e.model) === key(served)))
		return false;
	return (
		!!routerMetadata?.model &&
		!routerMetadata.route &&
		!!requestedModelId &&
		base(routerMetadata.model) !== base(requestedModelId) &&
		resolveModelIdentity(routerMetadata.model).makerShort !==
			resolveModelIdentity(requestedModelId).makerShort
	);
}

// The third slot of the provenance badge is the ACTUAL inference provider that
// served the answer (read per-request from the HF router's x-inference-provider
// header), not a hardcoded compute box — so the badge can't claim a datacenter
// the request didn't hit. CUR-3562: with no provider captured it returns nothing, and the caller
// leaves the segment out. A default label here would be a forecast from config, which reads as the
// turn's record and is wrong whenever a direct lane or a fallback served the turn.
export function providerDisplay(provider?: string): string | undefined {
	if (!provider) return undefined;
	return (
		PROVIDER_NAMES[provider.toLowerCase()] ?? provider.replace(/\b\w/g, (c) => c.toUpperCase())
	);
}

/** How the composer's "Local" panel should describe the server that answered.
 *
 *  The name is the label the person gave the server when they added it: a local model's display
 *  name is built as `${label}:${servedModelId}` (localModels.ts's buildLocalProcessedModel), so
 *  everything before the FIRST colon is the label — the served id routinely contains colons of its
 *  own ("llama3.2:latest", "hf.co/owner/repo:Q4_K_M") and splitting on the last one would return a
 *  quantization tag instead of a machine name.
 *
 *  `managed` decides which route the panel describes, and the default matters: an unknown kind is
 *  treated as direct, which promises strictly less (no encrypted tunnel). Claiming a tunnel that
 *  isn't there would be a privacy assurance we cannot stand behind. */
export function describeLocalServer(
	displayName: string | undefined,
	kind: "direct" | "managed" | undefined
): { name: string; managed: boolean } {
	const name = (displayName ?? "").split(":")[0].trim();
	return {
		// With no label to read, say something true rather than guessing a machine name.
		name: name || "your own computer",
		managed: kind === "managed",
	};
}
