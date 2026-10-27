import { describe, expect, it } from "vitest";
import { hfBillToHeader, requestBillTo } from "./hfBillTo";

const hf = (base: string) => "X-HF-Bill-To" in hfBillToHeader(base, { ownLane: false }, "org");

const global = { ownLane: false };

describe("hfBillToHeader (CUR-1877)", () => {
	it("sends the org only to the HF router", () => {
		expect(hfBillToHeader("https://router.huggingface.co/v1", global, "org")).toEqual({
			"X-HF-Bill-To": "org",
		});
	});

	it("sends nothing to the LiteLLM gateway, the preview adapter, or a maker's own API", () => {
		for (const base of [
			"https://api-internal.publicai.co/v1",
			"https://develop.aipotluck.org/folkways-adapter/v1",
			"https://api.mistral.ai/v1",
		]) {
			expect(hfBillToHeader(base, global, "org")).toEqual({});
		}
	});

	it("sends nothing on an own lane, even when it points at the HF router", () => {
		expect(hfBillToHeader("https://router.huggingface.co/v1", { ownLane: true }, "org")).toEqual({});
	});

	it("sends nothing when no org is configured (empty or whitespace)", () => {
		expect(hfBillToHeader("https://router.huggingface.co/v1", global, undefined)).toEqual({});
		expect(hfBillToHeader("https://router.huggingface.co/v1", global, "  ")).toEqual({});
	});

	it("does not take a look-alike host for the HF router", () => {
		expect(hf("https://huggingface.co.evil.example/v1")).toBe(false);
		expect(hf("https://nothuggingface.co/v1")).toBe(false);
		expect(hf("not a url")).toBe(false);
	});

	it("still matches the router on a non-default port or with a trailing dot", () => {
		expect(hf("https://router.huggingface.co:8443/v1")).toBe(true);
		expect(hf("https://router.huggingface.co./v1")).toBe(true);
	});
});

describe("requestBillTo (CUR-3533)", () => {
	it("ignores a visitor's org setting while the server token pays, and bills HF_BILL_TO", () => {
		expect(requestBillTo("someone-elses-org", { useUserToken: false, billTo: "ours" })).toBe("ours");
		expect(requestBillTo("someone-elses-org", { useUserToken: false, billTo: undefined })).toBe(
			undefined
		);
	});

	it("takes the visitor's org only when their own token pays (USE_USER_TOKEN)", () => {
		expect(requestBillTo("their-org", { useUserToken: true, billTo: "ours" })).toBe("their-org");
		expect(requestBillTo("  ", { useUserToken: true, billTo: "ours" })).toBe("ours");
	});
});
