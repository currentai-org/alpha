// Where a helper model ran, in words a visitor can read. The stored value is a host
// (routerMetadata.assistedBy[].backend) or the HF router's provider; a dedicated Inference Endpoint's
// host is a random id, which says nothing to someone who has never heard of one. (CUR-984)

import { backendDisplay, backendHost } from "$lib/chat/servingProvenance";

// The HF router's provider ids, as each provider names itself (CUR-4192). An id missing here shows as
// it is.
const HF_PROVIDER_NAMES: Record<string, string> = {
	cerebras: "Cerebras",
	cohere: "Cohere",
	"fal-ai": "fal",
	"featherless-ai": "Featherless AI",
	"fireworks-ai": "Fireworks AI",
	groq: "Groq",
	"hf-inference": "HF Inference",
	hyperbolic: "Hyperbolic",
	nebius: "Nebius AI",
	novita: "Novita AI",
	nscale: "Nscale",
	ovhcloud: "OVHcloud",
	publicai: "Public AI",
	replicate: "Replicate",
	sambanova: "SambaNova",
	scaleway: "Scaleway",
	together: "Together AI",
};

/** The readable name for where a helper ran, from its own call's record only: the HF router's provider
 *  when the call went through the router, else a label for the host, else the host as it is. Never the
 *  catalogue's planned host for the model: a backup lane or a proxy can serve the call somewhere else
 *  (CUR-3563). "" when nothing was recorded. */
export function assistHostLabel(entry: { backend?: string; provider?: string }): string {
	const recorded = (entry.backend ?? "").trim().toLowerCase();
	// Some calls record a base URL rather than a host (CUR-4192): Bielik's panel take stored
	// "https://llmlab.plgrid.pl/api/v1".
	const host = recorded.includes("://") ? backendHost(recorded) || recorded : recorded;
	// A provider is the HF router's pick only when the call went through the router. A direct call to
	// Mistral's API records provider "mistral" too, and that ran at Mistral, not via Hugging Face.
	const provider = entry.provider?.trim();
	if (provider && (!host || host === "router.huggingface.co")) return `${HF_PROVIDER_NAMES[provider.toLowerCase()] ?? provider} via Hugging Face`;
	if (!host) return "";
	// <id>.<region>.<cloud>.endpoints.huggingface.cloud, the form HF retires on 2026-11-20 (CUR-2524)
	const endpoint = host.match(/^[^.]+\.([a-z0-9-]+)\.([a-z0-9]+)\.endpoints\.huggingface\.cloud$/);
	if (endpoint) return `a Hugging Face Inference Endpoint (${endpoint[2].toUpperCase()} ${endpoint[1]})`;
	// <id>.endpoints.huggingface.cloud, which names no region
	if (/^[^.]+\.endpoints\.huggingface\.cloud$/.test(host)) return "a Hugging Face Inference Endpoint";
	if (host === "router.huggingface.co" || host.endsWith(".huggingface.co")) return "Hugging Face";
	if (host === "api.mistral.ai") return "Mistral AI";
	// Our own model router, which the maths-routing call records as its host (CUR-3941). It names where
	// the call went first, not the model's host behind it, so the label claims nothing further.
	if (host === "router.stg.aipotluck.org") return "Alpha's model router";
	return backendDisplay(`https://${host}`) ?? host;
}
