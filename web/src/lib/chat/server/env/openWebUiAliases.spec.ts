import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { extraEndpointEnv, filedExtraEndpoints, openWebUiExtraEndpoints, resolveOpenAiEnv } from "./openWebUiAliases";

// The cases live in one JSON file that the self-host agent gateway's Python resolver is tested against too
// (agent-service/api/test_openwebui_env.py), so the web app and the gateway read Open WebUI's names alike.
type AliasCase = {
	name: string;
	env: Record<string, string>;
	expect?: Record<string, unknown>;
	absent?: string[];
	throws?: boolean;
};
const fixture = new URL("../../../../../../agent-service/api/testdata/openwebui-env-cases.json", import.meta.url);
const { cases } = JSON.parse(readFileSync(fixture, "utf8")) as { cases: AliasCase[] };

describe("resolveOpenAiEnv", () => {
	it("reads a non-empty shared case list", () => {
		expect(cases.length).toBeGreaterThan(10);
	});

	for (const c of cases) {
		it(c.name, () => {
			if (c.throws) {
				expect(() => resolveOpenAiEnv(c.env)).toThrow();
				return;
			}
			const r = resolveOpenAiEnv(c.env) as Record<string, unknown>;
			expect(r).toMatchObject(c.expect ?? {});
			for (const key of c.absent ?? []) expect(r[key], key).toBeUndefined();
		});
	}
});

// Every entry past the first is an extra endpoint whose models Alpha offers.
describe("openWebUiExtraEndpoints", () => {
	it("returns every entry past the first, keys paired by position, an empty key kept empty", () => {
		expect(
			openWebUiExtraEndpoints({
				OPENAI_API_BASE_URLS: "http://llama:8080/v1;https://frontier.example/v1/;http://third:9000/v1",
				OPENAI_API_KEYS: "none;sk-frontier",
			})
		).toEqual([
			{ n: 2, baseUrl: "https://frontier.example/v1", apiKey: "sk-frontier" },
			{ n: 3, baseUrl: "http://third:9000/v1", apiKey: "" },
		]);
	});

	it("returns nothing for one entry, so a single endpoint behaves as before", () => {
		expect(openWebUiExtraEndpoints({ OPENAI_API_BASE_URLS: "http://llama:8080/v1", OPENAI_API_KEYS: "none" })).toEqual([]);
	});

	it("returns nothing when Alpha's own OPENAI_BASE_URL is set, which wins over the Open WebUI names", () => {
		expect(
			openWebUiExtraEndpoints({ OPENAI_BASE_URL: "http://own/v1", OPENAI_API_BASE_URLS: "http://a/v1;http://b/v1" })
		).toEqual([]);
	});

	it("skips an empty entry in the middle and keeps later keys paired by position", () => {
		expect(
			openWebUiExtraEndpoints({ OPENAI_API_BASE_URLS: "http://a/v1;;http://c/v1", OPENAI_API_KEYS: "ka;kb;kc" })
		).toEqual([{ n: 3, baseUrl: "http://c/v1", apiKey: "kc" }]);
	});

	it("reads back what config.ts files under the numbered names, in list order", () => {
		const filed: Record<string, string> = {
			[extraEndpointEnv(2).urlEnv]: "https://frontier.example/v1",
			[extraEndpointEnv(4).urlEnv]: "http://fourth/v1",
		};
		expect(filedExtraEndpoints((name) => filed[name])).toEqual([
			{ n: 2, baseURL: "https://frontier.example/v1", apiKeyEnv: "OWUI_ENDPOINT_2_KEY" },
			{ n: 4, baseURL: "http://fourth/v1", apiKeyEnv: "OWUI_ENDPOINT_4_KEY" },
		]);
	});
});
