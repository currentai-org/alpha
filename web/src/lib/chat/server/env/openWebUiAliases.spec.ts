import { describe, it, expect } from "vitest";
import { resolveOpenAiEnv } from "./openWebUiAliases";

describe("resolveOpenAiEnv", () => {
	it("uses Open WebUI's first URL and key when OPENAI_BASE_URL is unset", () => {
		const r = resolveOpenAiEnv({
			OPENAI_API_BASE_URLS: "http://llama:8080/v1",
			OPENAI_API_KEYS: "sk-one",
		});
		expect(r).toEqual({
			source: "open-webui",
			baseUrl: "http://llama:8080/v1",
			apiKey: "sk-one",
			ignoredEndpoints: 0,
			openWebUiShadowed: false,
		});
	});

	it("keeps Alpha's own OPENAI_BASE_URL when both name sets are set, and says the Open WebUI set was shadowed", () => {
		const r = resolveOpenAiEnv({
			OPENAI_BASE_URL: "https://alpha.example/v1",
			OPENAI_API_KEY: "alpha-key",
			OPENAI_API_BASE_URLS: "http://other/v1",
			OPENAI_API_KEYS: "other-key",
		});
		expect(r.source).toBe("alpha");
		expect(r.baseUrl).toBeUndefined();
		expect(r.openWebUiShadowed).toBe(true);
	});

	it("does nothing when only Alpha's names are set (the www shape)", () => {
		const r = resolveOpenAiEnv({ OPENAI_BASE_URL: "https://gw/v1", OPENAI_API_KEY: "k" });
		expect(r).toEqual({ source: "alpha", ignoredEndpoints: 0, openWebUiShadowed: false });
	});

	it("reports neither set as none", () => {
		expect(resolveOpenAiEnv({}).source).toBe("none");
	});

	it("boots like Open WebUI when keys are fewer than URLs: the first pair is used and the key count is reported", () => {
		const r = resolveOpenAiEnv({ OPENAI_API_BASE_URLS: "http://a/v1;http://b/v1", OPENAI_API_KEYS: "k1" });
		expect(r).toMatchObject({ source: "open-webui", baseUrl: "http://a/v1", apiKey: "k1", keysGiven: 1, ignoredEndpoints: 1 });
	});

	it("treats a URL with no key at all as a keyless endpoint, as Open WebUI does, instead of refusing to boot", () => {
		const r = resolveOpenAiEnv({ OPENAI_API_BASE_URLS: "http://llama:8080/v1" });
		expect(r).toMatchObject({ source: "open-webui", baseUrl: "http://llama:8080/v1", apiKey: "", keysGiven: 0 });
	});

	it("falls back to OPENAI_API_KEY when OPENAI_API_KEYS is unset, as Open WebUI does", () => {
		const r = resolveOpenAiEnv({ OPENAI_API_BASE_URLS: "http://a/v1", OPENAI_API_KEY: "single" });
		expect(r).toMatchObject({ source: "open-webui", apiKey: "single" });
		expect(r.keysGiven).toBeUndefined();
	});

	it("drops keys past the last URL and reports how many were given", () => {
		const r = resolveOpenAiEnv({ OPENAI_API_BASE_URLS: "http://a/v1", OPENAI_API_KEYS: "k1;k2" });
		expect(r).toMatchObject({ apiKey: "k1", keysGiven: 2, ignoredEndpoints: 0 });
	});

	it("takes the first pair of several and counts the endpoints it cannot serve", () => {
		const r = resolveOpenAiEnv({
			OPENAI_API_BASE_URLS: "http://a/v1;http://b/v1;http://c/v1",
			OPENAI_API_KEYS: "ka;kb;kc",
		});
		expect(r.baseUrl).toBe("http://a/v1");
		expect(r.apiKey).toBe("ka");
		expect(r.ignoredEndpoints).toBe(2);
	});

	it("accepts a keyless first endpoint written as an empty key", () => {
		const r = resolveOpenAiEnv({ OPENAI_API_BASE_URLS: "http://a/v1;http://b/v1", OPENAI_API_KEYS: ";kb" });
		expect(r.apiKey).toBe("");
		expect(r.ignoredEndpoints).toBe(1);
	});

	it("ignores one trailing separator on both lists", () => {
		const r = resolveOpenAiEnv({ OPENAI_API_BASE_URLS: "http://a/v1;", OPENAI_API_KEYS: "ka;" });
		expect(r.baseUrl).toBe("http://a/v1");
		expect(r.ignoredEndpoints).toBe(0);
	});
});
