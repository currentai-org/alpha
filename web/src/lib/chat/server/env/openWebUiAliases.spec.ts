import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { resolveOpenAiEnv } from "./openWebUiAliases";

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
