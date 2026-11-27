// Its own module, importing nothing, so the e2e scenarios can read the table without loading
// modelProfiles.ts and its JSON import, which Playwright's loader refuses.

/**
 * Models pinned to one Hugging Face provider on EVERY router call, reasoning on or off. Unpinned, the
 * router picks a provider per request, and for GLM-5.3 the candidates disagree on data terms and on
 * how to turn reasoning off (`scripts/glm-provider-probe.mjs`; table in
 * `docs/guides/inference-topology-matrix.md`). The entry is the choice of who receives visitor text,
 * so changing it needs the privacy notice to name the new provider first. This is a policy
 * decision rather than a measurement, which is why it sits beside the probe's rows instead of in them;
 * a pin to a provider with no verified row fails `modelProfiles.spec.ts`. Keys are lower-case.
 */
export const HF_PROVIDER_PIN: Readonly<Record<string, string>> = {
	// Hosts in the EU first, then the US, never China, so neither Z.ai's own endpoint nor Novita.
	// GLM has no row: no router host serves GLM 5.2 or 5.3 without passing the text through OpenRouter,
	// so Alpha calls no GLM model.
	// The second-opinion panel's other two members. Unpinned, the router sends them to Novita
	// or DeepInfra. Featherless caps our account at 10 units and a Qwen call costs 2, so a burst answers
	// 429; DeepInfra answered 30 of 30 at once and stores no prompts or answers. Qwen's
	// DeepInfra calls now pass through OpenRouter as GLM's did, so Qwen is off the panel
	// (ROLE_MODELS.COMPARE_PANEL); the pin stays so a call that still names it never goes where the
	// router picks. No direct provider fits: on Featherless it wrote its reasoning into the answer and
	// ran two of six calls to the 4,096-token cap, and Scaleway answers 402.
	"qwen/qwen3.6-35b-a3b": "deepinfra",
	"google/gemma-4-31b-it": "featherless-ai",
};
