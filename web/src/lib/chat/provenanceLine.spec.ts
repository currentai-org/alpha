import { describe, expect, it } from "vitest";
import { provenanceLine, ranOn } from "./provenanceLine";

describe("provenanceLine — the whole record the answer footer abbreviates", () => {
	it("names the model, its maker, the provider and the measured compute", () => {
		const line = provenanceLine({
			modelId: "mistral-large-2512",
			provider: "mistral",
			backend: "https://api.mistral.ai/v1",
		});
		expect(line).toContain("served via Mistral AI");
		expect(line).toContain("compute: Mistral AI La Plateforme (France)");
		expect(line.split(" · ")[0]).toMatch(/Mistral Large 3/);
	});

	it("names OpenRouter as the provider and Mistral as the compute for a Large 4 answer it routed to Mistral", () => {
		const line = provenanceLine({
			modelId: "mistral-large-2610",
			provider: "openrouter",
			backend: "https://api.mistral.ai/v1",
		});
		expect(line).toContain("served via OpenRouter · compute: Mistral AI La Plateforme (France)");
	});

	it("names DeepInfra, not \"Deepinfra\", for a GLM 5.2 answer the HF router served there", () => {
		const line = provenanceLine({ modelId: "zai-org/GLM-5.2", provider: "deepinfra" });
		expect(line).toContain("served via DeepInfra");
		expect(line).not.toContain("Deepinfra");
	});

	it("names Featherless, not \"Featherless-Ai\", for an answer the HF router served there", () => {
		const line = provenanceLine({ modelId: "zai-org/GLM-5.2", provider: "featherless-ai" });
		expect(line).toContain("served via Featherless");
		expect(line).not.toContain("Featherless-Ai");
	});

	it("names no compute for a backend nobody vetted, rather than guessing", () => {
		expect(provenanceLine({ modelId: "swiss-ai/apertus-v1.5-70b", backend: "https://unknown.example" })).not.toContain(
			"compute:"
		);
	});

	it("names Scaleway, never La Plateforme, when the Mistral lane's turn records Scaleway's host", () => {
		const line = provenanceLine({
			modelId: "mistral-medium-3.5-128b",
			provider: "mistral",
			backend: "https://api.scaleway.ai/v1",
		});
		expect(line).toContain("compute: Scaleway (France)");
		expect(line).not.toContain("La Plateforme");
	});

	it("says the host was not recorded when the turn reported neither provider nor compute", () => {
		const line = provenanceLine({ modelId: "swiss-ai/apertus-v1.5-70b" });
		expect(line).toMatch(/ · host not recorded$/);
		expect(line).not.toContain("served via");
	});

	it("says when a backup served in place of the primary model", () => {
		expect(provenanceLine({ modelId: "swiss-ai/apertus-v1.5-70b", backup: true })).toContain("(backup");
	});

	it("never calls an answer verified — it names the checks that ran, not a verdict", () => {
		for (const verifyMethod of ["", "execution", "judge", "execution+judge"]) {
			const line = provenanceLine({ modelId: "mistral-large-2512", verifyMethod });
			expect(line, `verifyMethod=${JSON.stringify(verifyMethod)} must not claim verification`).not.toMatch(
				/verif/i
			);
		}
		expect(provenanceLine({ modelId: "mistral-large-2512", verifyMethod: "execution+judge" })).toContain(
			"checks run: execution + reviewer model"
		);
	});
});

describe("ranOn — X-ray's \"Where it ran\", read from the turn's routing record", () => {
	it("credits a measured backend that is a catalogue organisation, with its country", () => {
		const ran = ranOn("https://api.infomaniak.com/2/ai/123/openai/v1");
		expect(ran?.label).toBe("Infomaniak (Switzerland)");
		expect(ran?.org?.name).toBe("Infomaniak");
		expect(ran?.org?.region).toBe("Switzerland");
	});

	it("credits Scaleway for a Mistral Medium turn it served, not Mistral's own platform", () => {
		const ran = ranOn("https://api.scaleway.ai/v1", "mistral");
		expect(ran?.label).toBe("Scaleway (France)");
		expect(ran?.org?.name).toBe("Scaleway");
	});

	it("credits ALIA's and Bielik's recorded hosts by name, never \"not recorded\"", () => {
		const alia = ranOn("https://api.nextbit256.com/v1");
		expect(alia?.label).toBe("NextBit");
		expect(alia?.org?.name).toBe("NextBit");
		const bielik = ranOn("https://llmlab.plgrid.pl/api/v1");
		expect(bielik?.label).toBe("PLGrid (Poland)");
		expect(bielik?.org?.region).toBe("Poland");
	});

	it("credits Apertus's recorded Phoeniqs host by name, never \"not recorded\"", () => {
		expect(ranOn("https://maas.phoeniqs.com/v1")?.label).toBe("Phoeniqs (Switzerland)");
	});

	it("credits every measured backend in the catalog's host table with its org, Swiss or not", () => {
		const featherless = ranOn("https://api.featherless.ai/v1");
		expect(featherless?.label).toBe("Featherless (United States)");
		expect(featherless?.org?.region).toBe("United States");
		const phoeniqs = ranOn("https://maas.phoeniqs.com/v1");
		expect(phoeniqs?.label).toBe("Phoeniqs (Switzerland)");
		expect(phoeniqs?.org).toMatchObject({ name: "Phoeniqs", url: "https://phoeniqs.com", region: "Switzerland" });
	});

	it("names the provider the router reported when the backend is not one we name", () => {
		expect(ranOn("https://router.huggingface.co/v1", "together")).toEqual({ label: "Together" });
	});

	it("claims nothing when the record names neither a known backend nor a provider", () => {
		// The caller then says "not recorded" rather than falling back to the catalogue's planned host.
		expect(ranOn(undefined)).toBeUndefined();
		expect(ranOn("https://unvetted.example/v1")).toBeUndefined();
		expect(ranOn(undefined, "")).toBeUndefined();
	});
});
