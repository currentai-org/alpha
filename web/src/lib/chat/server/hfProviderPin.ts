// Its own module, importing nothing, so the e2e scenarios can read the table without loading
// modelProfiles.ts and its JSON import, which Playwright's loader refuses (CUR-1683).

/**
 * Models pinned to one Hugging Face provider on EVERY router call, reasoning on or off. Unpinned, the
 * router picks a provider per request, and for GLM-5.3 the candidates disagree on data terms and on
 * how to turn reasoning off (`scripts/glm-provider-probe.mjs`; table in
 * `docs/guides/inference-topology-matrix.md`). The entry is the choice of who receives visitor text,
 * so changing it needs the privacy notice to name the new provider first (CUR-2063). This is a policy
 * decision rather than a measurement, which is why it sits beside the probe's rows instead of in them;
 * a pin to a provider with no verified row fails `modelProfiles.spec.ts`. Keys are lower-case.
 */
export const HF_PROVIDER_PIN: Readonly<Record<string, string>> = {
	// Scaleway: Paris processing, no retention by default, no training. Chosen over every GLM-5.3
	// provider on data terms and on probe results.
	"zai-org/glm-5.2": "scaleway",
	// The known exception: Z.ai's own endpoint is GLM-5.2-FP8's only provider on the router, and
	// production's second opinion runs it. Pinned so the choice is written down; it moves off Z.ai with
	// CUR-2321.
	"zai-org/glm-5.2-fp8": "zai-org",
	// The second-opinion panel's other two members (CUR-2599). Unpinned, the router can send Gemma to Novita, and
	// DeepInfra serves both; the privacy notice names neither. Scaleway as for GLM above.
	"qwen/qwen3.6-35b-a3b": "scaleway",
	// Featherless does not log prompts or answers.
	"google/gemma-4-31b-it": "featherless-ai",
};
