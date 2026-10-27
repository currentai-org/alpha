import { describe, it, expect } from "vitest";
import { providerDisplay, resolveModelIdentity, servedByBackup } from "$lib/chat/identity";
import { backendDisplay, backendIsSwiss, baseURLForModel, resolveServing } from "$lib/chat/servingProvenance";
import { buildProvenanceFacts } from "./provenanceFacts";
import { buildPersonaPrompt, servingClause } from "./persona";
import { buildServingNote } from "./grounding";

// When Mistral Large 3 serves, every surface that says who made the model and where it runs
// names Mistral AI and La Plateforme (France), never Apertus, SNAI, or public compute. The wire id and
// base URL are the ones CUR-2272 configures. (CUR-2274)
const LARGE_3 = "mistral-large-2512";
const MISTRAL_BASE = "https://api.mistral.ai/v1";
const GATEWAY_BASE = "https://api-internal.example/v1";
const APERTUS = "swiss-ai/Apertus-70B-Instruct-2509";

describe("Large 3 identity", () => {
	it("names Mistral AI as the maker and Mistral Large 3 as the model, not Apertus or SNAI", () => {
		const id = resolveModelIdentity(LARGE_3);
		expect(id.short).toBe("Mistral Large 3");
		expect(id.maker).toBe("Mistral AI");
		expect(id.openness).toBe("open weights");
		// No training-data claim: Mistral does not publish its training data, so the persona must not
		// splice Apertus's "fully open" fact in.
		expect(id.training).toBe("");
		expect(id.card).toBe("mistralai/Mistral-Large-3-675B-Instruct-2512");
	});

	it("links the badge's weights control to the public Large 3 card, not the swiss-ai org page", () => {
		expect(resolveServing(MISTRAL_BASE, LARGE_3).checkpointUrl).toBe(
			"https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512"
		);
	});

	it("reads a Large 3 answer as a backup when Apertus was requested, since the makers differ", () => {
		expect(servedByBackup({ model: LARGE_3 }, APERTUS)).toBe(true);
		expect(servedByBackup({ model: LARGE_3 }, LARGE_3)).toBe(false);
	});
});

describe("Large 3 serving label comes from the endpoint the model is sent to", () => {
	const large3 = { endpoints: [{ type: "openai", baseURL: MISTRAL_BASE }] };
	const catalogModel = { endpoints: [{ type: "openai", baseURL: GATEWAY_BASE }] };
	const agentModel = { endpoints: [{ type: "agent", baseURL: "https://agent.example" }] };

	it("takes the model's own endpoint, and keeps the deployment fallback for catalog and agent models", () => {
		expect(baseURLForModel(large3, GATEWAY_BASE)).toBe(MISTRAL_BASE);
		expect(baseURLForModel(catalogModel, "https://other.example/v1")).toBe(GATEWAY_BASE);
		expect(baseURLForModel(agentModel, GATEWAY_BASE)).toBe(GATEWAY_BASE);
		expect(baseURLForModel(undefined, GATEWAY_BASE)).toBe(GATEWAY_BASE);
	});

	it("names La Plateforme in France and claims neither Switzerland nor sovereign or public compute", () => {
		const s = resolveServing(baseURLForModel(large3, GATEWAY_BASE), LARGE_3);
		expect(s.providerLabel).toBe("Mistral AI's La Plateforme");
		expect(s.directCountry).toBe("France");
		expect(s.isSovereign).toBe(false);
		expect(s.namesSwitzerland).toBe(false);
		for (const line of [s.computeTail, s.heroServingLine, s.welcomeServingLine]) {
			expect(line).toContain("La Plateforme in France");
			expect(line).not.toMatch(/Public AI Inference Utility|HuggingFace|Switzerland|public compute\./);
		}
	});

	it("names La Plateforme as the measured backend on the badge, and does not count it as Swiss", () => {
		expect(backendDisplay(MISTRAL_BASE)).toBe("Mistral AI La Plateforme (France)");
		expect(backendIsSwiss(MISTRAL_BASE)).toBe(false);
		expect(providerDisplay("mistral")).toBe("Mistral AI");
	});
});

describe("what the model is told about itself when Large 3 serves", () => {
	const serving = resolveServing(MISTRAL_BASE, LARGE_3);

	it("per-turn provenance facts name Mistral AI as the maker and no host, even on its direct lane (CUR-3562)", () => {
		// A fallback can serve a Large 3 turn somewhere else, so La Plateforme is a forecast here.
		const facts = buildProvenanceFacts({ modelId: LARGE_3 });
		expect(facts).toContain("You are Mistral Large 3, built by Mistral AI.");
		expect(facts).not.toMatch(/La Plateforme|France|Apertus|Swiss National AI|Public AI Inference Utility/);
	});

	it("a persona deferring to the per-turn facts names no host in its few-shot either (CUR-3562)", () => {
		const prompt = buildPersonaPrompt(LARGE_3, undefined, { serving, deferServing: true });
		expect(prompt).toContain("used here through AI Potluck, the chat app Current AI runs");
		expect(prompt).not.toMatch(/La Plateforme|in France/);
	});

	it("the persona names Mistral AI and La Plateforme, and drops the Apertus-only claims", () => {
		const prompt = buildPersonaPrompt(LARGE_3, undefined, { serving });
		expect(prompt).toContain("You are Mistral Large 3, an open-weights model developed by Mistral AI");
		expect(prompt).toContain("sends your requests directly to Mistral AI's La Plateforme in France");
		expect(prompt).toContain("open weights from Mistral AI, served directly by Mistral AI's La Plateforme in France.");
		expect(prompt).not.toMatch(/Apertus|Swiss National AI|SNAI|run on public compute|training data are all openly published/);
		expect(prompt).not.toContain("{computeFewShot}");
	});

	it("gives the Apertus few-shot no compute claim on a gateway lane, since the gateway picks the host (CUR-2135)", () => {
		const prompt = buildPersonaPrompt(APERTUS, undefined, {
			serving: resolveServing(GATEWAY_BASE, APERTUS, "api-internal.example=Gateway"),
		});
		expect(prompt).toContain("used here through AI Potluck, the chat app Current AI runs");
		expect(prompt).not.toMatch(/public compute/);
		expect(prompt).not.toContain("{computeFewShot}");
	});

	// "served here by Current AI" can come back as "served directly by Current AI".
	// Current AI runs the app; only the host may be said to serve or run the model. (CUR-2135)
	it("never tells the model that Current AI serves, hosts or runs it, on a direct or a gateway lane", () => {
		const operatorAsHost = /(serv(e|es|ed)|host(s|ed)?|runs?)\b[^.;]{0,20}\bby Current AI|Current AI (serves|hosts|runs) (you|the model)/;
		for (const s of [serving, resolveServing(GATEWAY_BASE, APERTUS, "api-internal.example=Gateway")]) {
			const prompt = buildPersonaPrompt(APERTUS, undefined, { serving: s, deferServing: true });
			expect(prompt).not.toMatch(operatorAsHost);
			expect(buildProvenanceFacts({ modelId: APERTUS })).not.toMatch(operatorAsHost);
		}
	});

	it("the serving clause and the grounding note both name La Plateforme in France", () => {
		expect(servingClause(serving)).toContain("directly to Mistral AI's La Plateforme in France");
		const note = buildServingNote(serving);
		expect(note).toContain("served directly by Mistral AI's La Plateforme in France");
		expect(note).not.toMatch(/CSCS|Apertus/);
	});
});
