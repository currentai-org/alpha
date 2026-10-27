import { describe, it, expect, vi, afterEach } from "vitest";

// heuristicSources reads syftEnabled() → syft().token off the config proxy. Mock the config so we
// can toggle the SyftHub token and assert the gate.
const { configValues } = vi.hoisted(() => ({ configValues: {} as Record<string, string> }));
vi.mock("$lib/chat/server/config", () => ({ config: configValues }));

import { heuristicSources, decideRagSources } from "./router";

afterEach(() => {
	for (const k of Object.keys(configValues)) delete configValues[k];
});

describe("rag router gate", () => {
	it("keeps the local catalog store on always (the product default)", () => {
		expect(heuristicSources().local).toBe(true);
		configValues.SYFTHUB_API_TOKEN = "tok";
		expect(heuristicSources().local).toBe(true);
	});

	it("gates the federated store on the SyftHub token", () => {
		expect(heuristicSources().syft).toBe(false); // no token
		configValues.SYFTHUB_API_TOKEN = "tok";
		expect(heuristicSources().syft).toBe(true);
	});

	it("decideRagSources mirrors the heuristic gate", async () => {
		configValues.SYFTHUB_API_TOKEN = "tok";
		await expect(decideRagSources()).resolves.toEqual({ local: true, syft: true });
	});
});
