import { describe, it, expect } from "vitest";
import { providerMeta, PROVIDER_META, LINKABLE_PROVIDERS } from "./authProviderMeta";

describe("providerMeta", () => {
	it("labels every linkable provider", () => {
		for (const id of LINKABLE_PROVIDERS) {
			expect(providerMeta(id).label).toBeTruthy();
		}
	});

	it("falls back to the raw providerId for an unknown provider, rather than throwing", () => {
		const meta = providerMeta("some-future-provider");
		expect(meta.label).toBe("some-future-provider");
		expect(meta.Icon).toBeDefined();
	});

	it("stays in sync with LINKABLE_PROVIDERS — every linkable id has real PROVIDER_META", () => {
		for (const id of LINKABLE_PROVIDERS) {
			expect(PROVIDER_META[id]).toBeDefined();
		}
	});
});
