import { describe, expect, it } from "vitest";
import { assistHostLabel } from "./assistHost";
import type { AssistedBy } from "$lib/chat/types/Message";

describe("assistHostLabel — where a helper model ran, readable (CUR-984)", () => {
	it("names a dedicated Inference Endpoint by kind and region, never by its random host id", () => {
		const label = assistHostLabel({
			backend: "qq3dg9pgwfj93bbm.eu-west-1.aws.endpoints.huggingface.cloud",
		});
		expect(label).toBe("a Hugging Face Inference Endpoint (AWS eu-west-1)");
		expect(label).not.toContain("qq3dg9pgwfj93bbm");
	});

	it("names an endpoint on HF's region-free host the same way, never by its id (CUR-2524)", () => {
		const label = assistHostLabel({ backend: "6abe43bafcf6e676f4ecc8c9.endpoints.huggingface.cloud" });
		expect(label).toBe("a Hugging Face Inference Endpoint");
		expect(label).not.toContain("6abe43bafcf6e676f4ecc8c9");
	});

	it("names Mistral's own API and the HF router by their makers", () => {
		expect(assistHostLabel({ backend: "api.mistral.ai" })).toBe("Mistral AI");
		expect(assistHostLabel({ backend: "router.huggingface.co" })).toBe("Hugging Face");
	});

	it("prefers the HF router's provider, the host that actually ran the call", () => {
		expect(assistHostLabel({ backend: "router.huggingface.co", provider: "scaleway" })).toBe(
			"Scaleway via Hugging Face"
		);
	});

	it("names the HF router's provider as it names itself, never by its id (CUR-4192)", () => {
		expect(assistHostLabel({ provider: "featherless-ai" })).toBe("Featherless AI via Hugging Face");
		expect(assistHostLabel({ provider: "some-new-provider" })).toBe("some-new-provider via Hugging Face");
	});

	it("names a host recorded as a base URL by its institution, never as the URL (CUR-4192)", () => {
		const label = assistHostLabel({ backend: "https://llmlab.plgrid.pl/api/v1" });
		expect(label).toBe("PLGrid (Poland)");
		expect(label).not.toContain("://");
		expect(assistHostLabel({ backend: "https://llm.example.org/v1" })).toBe("llm.example.org");
	});

	it("names a direct call to Mistral's API as Mistral AI, never via Hugging Face, though it records a provider", () => {
		const title: AssistedBy = {
			role: "title",
			model: "mistral-small-2603",
			backend: "api.mistral.ai",
			provider: "mistral",
		};
		expect(assistHostLabel(title)).toBe("Mistral AI");
	});

	it("names our own model router without its internal hostname (CUR-3941)", () => {
		const mathRoute: AssistedBy = {
			role: "math-route",
			model: "mistral-medium-2604",
			backend: "router.stg.aipotluck.org",
		};
		expect(assistHostLabel(mathRoute)).toBe("Alpha's model router");
	});

	it("shows an unknown host as it is rather than guessing a name for it", () => {
		expect(assistHostLabel({ backend: "llm.example.org" })).toBe("llm.example.org");
	});

	it("names only the recorded host, never the catalogue's planned host for the model (CUR-3563)", () => {
		// A Mistral model the catalogue hosts at Mistral AI, recorded on another host: the record wins.
		const proxied: AssistedBy = { role: "title", model: "mistral-medium-2604", backend: "proxy.example.org" };
		expect(assistHostLabel(proxied)).toBe("proxy.example.org");
	});

	it("is empty (shown as not recorded) when the call's record names no host, even for a catalogued model", () => {
		const unrecorded: AssistedBy = { role: "safety-screen", model: "mistral-medium-2604" };
		expect(assistHostLabel(unrecorded)).toBe("");
		expect(assistHostLabel({})).toBe("");
	});
});
