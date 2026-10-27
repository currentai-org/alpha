/**
 * The pure boot-snapshot helpers (TTFT plan §C): the snapshot loader must accept a valid, base-matched
 * artifact and reject an absent/invalid/mismatched one (so boot falls back to the live path), and the
 * drift comparison must key on the model-id SET (order-independent).
 */
import { describe, expect, it } from "vitest";
import { catalogEntrySchema, computeModelDrift, parseModelsSnapshot } from "./modelsSnapshot";

const BASE = "https://api.example/v1";
const validRaw = {
	fetchedAt: "2026-07-07T00:00:00.000Z",
	baseURL: BASE,
	entries: [{ id: "swiss-ai/Apertus-70B" }, { id: "meta/llama-3" }],
};

describe("parseModelsSnapshot", () => {
	it("returns null when the raw artifact is absent (null/undefined/non-object)", () => {
		expect(parseModelsSnapshot(null, BASE)).toBeNull();
		expect(parseModelsSnapshot(undefined, BASE)).toBeNull();
		expect(parseModelsSnapshot("nope", BASE)).toBeNull();
	});

	it("returns null for the committed empty-default (empty baseURL + entries) → live path", () => {
		expect(parseModelsSnapshot({ fetchedAt: "", baseURL: "", entries: [] }, BASE)).toBeNull();
	});

	it("returns null when entries is empty even if the baseURL matches", () => {
		expect(parseModelsSnapshot({ fetchedAt: "x", baseURL: BASE, entries: [] }, BASE)).toBeNull();
	});

	it("returns the parsed snapshot when valid AND the baseURL matches the configured primary", () => {
		const snap = parseModelsSnapshot(validRaw, BASE);
		expect(snap).not.toBeNull();
		expect(snap?.entries.map((e) => e.id)).toEqual(["swiss-ai/Apertus-70B", "meta/llama-3"]);
	});

	it("returns null when the baseURL does NOT match the configured primary (fallback-lane guard)", () => {
		expect(parseModelsSnapshot(validRaw, "https://other.example/v1")).toBeNull();
		expect(parseModelsSnapshot(validRaw, undefined)).toBeNull();
	});

	it("returns null for an invalid/stale-shape snapshot (an entry missing its id)", () => {
		const bad = { fetchedAt: "x", baseURL: BASE, entries: [{ name: "no-id" }] };
		expect(parseModelsSnapshot(bad, BASE)).toBeNull();
	});

	it("preserves passthrough entry fields (providers/architecture) the live shaper reads", () => {
		const raw = {
			fetchedAt: "x",
			baseURL: BASE,
			entries: [
				{
					id: "x/y",
					providers: [{ supports_tools: true }],
					architecture: { input_modalities: ["text", "image"] },
				},
			],
		};
		const snap = parseModelsSnapshot(raw, BASE);
		expect(snap?.entries[0]).toMatchObject({ id: "x/y", providers: [{ supports_tools: true }] });
	});
});

describe("catalogEntrySchema", () => {
	it("accepts explicit null providers/architecture (the CSCS direct-endpoint shape)", () => {
		const r = catalogEntrySchema.safeParse({ id: "a", providers: null, architecture: null });
		expect(r.success).toBe(true);
	});
});

describe("computeModelDrift", () => {
	it("reports no drift for identical id sets (order-independent)", () => {
		expect(computeModelDrift(["a", "b"], ["b", "a"]).drifted).toBe(false);
	});

	it("reports drift when a model is added upstream, with both sorted id sets", () => {
		const d = computeModelDrift(["a"], ["a", "b"]);
		expect(d.drifted).toBe(true);
		expect(d.snapshotIds).toEqual(["a"]);
		expect(d.liveIds).toEqual(["a", "b"]);
	});

	it("reports drift when a model is removed upstream", () => {
		expect(computeModelDrift(["a", "b"], ["a"]).drifted).toBe(true);
	});

	it("reports drift on a same-size disjoint swap", () => {
		expect(computeModelDrift(["a", "b"], ["a", "c"]).drifted).toBe(true);
	});
});
