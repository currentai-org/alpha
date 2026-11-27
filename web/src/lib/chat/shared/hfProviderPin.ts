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
	// Empty: no chat model is pinned. A pin names the host that receives visitor text, and the Hugging
	// Face router serves none of our chat models from a host the privacy notice names, so a router call
	// that names one is refused (providerPin.ts) and no compare or pinned model registers on the router
	// (models.ts, modelsCatalog.ts). A new row needs the privacy notice to name its
	// host first, and a probe showing the router serves the model from that host.
};
