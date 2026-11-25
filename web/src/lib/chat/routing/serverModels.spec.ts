import { describe, expect, it } from "vitest";
import { PICKER, pickerSites } from "../../../../config/picker";
import { catalog } from "./catalog";
import { serverModels } from "./serverModels";

const catalogued = catalog.find((m) => m.status === "live" && m.gatewayId)?.gatewayId as string;

describe("serverModels", () => {
	it("lists a self-hosted stack's own model, which the catalog does not know, by the name the server gave it", () => {
		expect(
			serverModels(["qwen2.5-0.5b-instruct", "frontier-stub"], [{ id: "qwen2.5-0.5b-instruct", displayName: "Qwen 0.5B" }])
		).toEqual([
			{ id: "qwen2.5-0.5b-instruct", name: "Qwen 0.5B" },
			{ id: "frontier-stub", name: "frontier-stub" },
		]);
	});

	it("leaves out a catalogued model and a person's own local endpoint, which have their own rows", () => {
		expect(catalogued).toBeTruthy();
		expect(serverModels([catalogued, "local:my-box:llama3", "qwen2.5-0.5b-instruct"], [])).toEqual([
			{ id: "qwen2.5-0.5b-instruct", name: "qwen2.5-0.5b-instruct" },
		]);
	});

	// The hosted sites serve only catalogued models, so the switcher there gains no rows.
	for (const site of pickerSites) {
		it(`is empty for every model the ${site} picker serves`, () => {
			expect(serverModels(PICKER[site], [])).toEqual([]);
		});
	}
});
