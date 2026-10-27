import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	computeRevealStages,
	computePulseNodes,
	ALL_STACK_NODE_IDS,
	CATALOG_RAG_NODE,
	SYFTHUB_RAG_NODE,
	EPFL_RAG_NODE,
	VAULT_NODE,
	ROUTER_NODE,
	backendComputeNode,
	modelNodeFor,
} from "./reveal";

// What a caller now passes: a node resolved from the backend the gateway reported for THIS answer.
const CSCS_NODE = backendComputeNode("https://api.inference.cscs.ch/v1");

describe("computeRevealStages — the live-stack honesty invariant", () => {
	it("a declined turn lights ONLY the safety classifier — never the model", () => {
		expect(computeRevealStages({ moderation: { flagged: true } })).toEqual(["safety"]);
		expect(
			computeRevealStages({ moderation: { flagged: true }, webSearch: { sources: [{}] } })
		).toEqual(["safety"]);
	});

	it("a searched turn reveals search → model, in real pipeline order", () => {
		expect(computeRevealStages({ webSearch: { sources: [{}, {}] } })).toEqual([
			"websearch",
			"apertus",
		]);
	});

	it("a RAG catalog turn reveals catalog-rag → model", () => {
		expect(
			computeRevealStages({
				rag: { sources: [{ engine: "Potluck", n: 1, title: "T", snippet: "S" }] },
			})
		).toEqual([CATALOG_RAG_NODE, "apertus"]);
	});

	it("an admin-authored community turn lights the catalog node too (Potluck-family)", () => {
		expect(
			computeRevealStages({
				rag: { sources: [{ engine: "Potluck:Community", n: 1, title: "T", snippet: "S" }] },
			})
		).toEqual([CATALOG_RAG_NODE, "apertus"]);
	});

	it("a federated EPFL turn reveals syft-epfl → model", () => {
		expect(
			computeRevealStages({
				rag: { sources: [{ engine: "SyftHub:EPFL", n: 1, title: "T", snippet: "S" }] },
			})
		).toEqual([EPFL_RAG_NODE, "apertus"]);
	});

	it("a generic federated SyftHub turn reveals syft-rag → model (not the catalog node)", () => {
		expect(
			computeRevealStages({
				rag: {
					sources: [{ engine: "SyftHub", n: 1, title: "T", snippet: "S", sourceName: "acme/news" }],
				},
			})
		).toEqual([SYFTHUB_RAG_NODE, "apertus"]);
	});

	it("a vault synthesis turn reveals localculture → model", () => {
		expect(
			computeRevealStages({ rag: { vaultSynthesis: "Charlie Chaplin lived in Vevey." } })
		).toEqual([VAULT_NODE, "apertus"]);
	});

	it("web + RAG compose in pipeline order before model", () => {
		expect(
			computeRevealStages({
				webSearch: { sources: [{}] },
				rag: { sources: [{ engine: "Potluck", n: 1, title: "T", snippet: "S" }] },
			})
		).toEqual(["websearch", CATALOG_RAG_NODE, "apertus"]);
	});

	it("a plain turn lights only the model", () => {
		expect(computeRevealStages({})).toEqual(["apertus"]);
		expect(computeRevealStages({ moderation: { flagged: false } })).toEqual(["apertus"]);
	});

	it("an empty search result is not a search turn — no websearch node", () => {
		expect(computeRevealStages({ webSearch: { sources: [] } })).toEqual(["apertus"]);
	});

	it("lights the sovereign compute cell only when the answer ran on it", () => {
		expect(computeRevealStages({})).toEqual(["apertus"]);
		expect(computeRevealStages({}, { computeNode: CSCS_NODE })).toEqual([
			"apertus",
			"cscs",
		]);
		expect(
			computeRevealStages({ webSearch: { sources: [{}] } }, { computeNode: CSCS_NODE })
		).toEqual(["websearch", "apertus", "cscs"]);
	});

	it("a declined turn never lights compute, even when sovereign-served", () => {
		expect(
			computeRevealStages({ moderation: { flagged: true } }, { computeNode: CSCS_NODE })
		).toEqual(["safety"]);
	});

	it("an OUTPUT-blocked turn lights the model pipeline AND the safety node (model ran, then withheld)", () => {
		// plain turn → model then safety
		expect(computeRevealStages({ outputModeration: { flagged: true } })).toEqual([
			"apertus",
			"safety",
		]);
		// grounded turn → search → model → safety, in pipeline order
		expect(
			computeRevealStages({
				outputModeration: { flagged: true },
				webSearch: { sources: [{}] },
			})
		).toEqual(["websearch", "apertus", "safety"]);
		// sovereign-served → ... → model → compute → safety
		expect(
			computeRevealStages(
				{ outputModeration: { flagged: true } },
				{ computeNode: CSCS_NODE }
			)
		).toEqual(["apertus", "cscs", "safety"]);
	});

	it("an INPUT decline still lights ONLY safety even if outputModeration is also present", () => {
		expect(
			computeRevealStages({
				moderation: { flagged: true },
				outputModeration: { flagged: true },
			})
		).toEqual(["safety"]);
	});

	it("a clean turn with output screening that did NOT flag lights the normal pipeline", () => {
		expect(computeRevealStages({ outputModeration: { flagged: false } })).toEqual(["apertus"]);
	});
});

describe("computePulseNodes — streaming pulse honesty (same gates, applied live)", () => {
	it("a plain streaming turn pulses only the model", () => {
		expect(computePulseNodes({})).toEqual(["apertus"]);
	});

	it("a web-grounded streaming turn also pulses the web-search node", () => {
		expect(computePulseNodes({ webGrounded: true })).toEqual(["apertus", "websearch"]);
	});

	it("a declined turn pulses ONLY the safety node — never web/model, even with sources attached", () => {
		// Client-side web search attaches sources before the pre-screen blocks the turn, so `webGrounded`
		// is true on a decline. The pulse must still light safety only (mirrors computeRevealStages) —
		// otherwise the live sidebar map falsely claims "searched the web" on a turn that never ran.
		expect(computePulseNodes({ declined: true })).toEqual(["safety"]);
		expect(computePulseNodes({ declined: true, webGrounded: true })).toEqual(["safety"]);
		expect(
			computePulseNodes({ declined: true, webGrounded: true, computeNode: CSCS_NODE })
		).toEqual(["safety"]);
		expect(computePulseNodes({ declined: true })).not.toContain("apertus");
		expect(computePulseNodes({ declined: true, webGrounded: true })).not.toContain("websearch");
	});

	it("a RAG streaming turn pulses the matching retrieval nodes", () => {
		expect(
			computePulseNodes({
				rag: { sources: [{ engine: "Potluck", n: 1, title: "T", snippet: "S" }] },
			})
		).toEqual(["apertus", CATALOG_RAG_NODE]);
	});

	it("NEVER pulses the sovereign compute cell while HF-served — false-sovereignty regression guard", () => {
		expect(computePulseNodes({})).not.toContain("cscs");
		expect(computePulseNodes({ webGrounded: true })).not.toContain("cscs");
	});

	// What lights the CSCS cell must be what served the turn. `servedOnSovereignCompute` must not be
	// filled from `serving.isSovereign`, a deployment-wide config constant that is true for every prod
	// turn, or the cell lights on turns the gateway sent to Infomaniak (CUR-75). Going dark for
	// Infomaniak is not the answer either: it serves a large share of real traffic, so the map shows it
	// rather than nothing (CUR-1124). Never CSCS; not dark. Assertions that only ask "does true light
	// it" cannot catch this, so these ask what is allowed to be true.
	it("synthesizes an honestly-named node for a Swiss backend the map has no bespoke entry for — never mislabels it as CSCS", () => {
		const infomaniak = backendComputeNode("https://api.infomaniak.com/2/ai/106744/openai/v1");
		expect(infomaniak).toBe("compute:api.infomaniak.com");
		expect(infomaniak).not.toBe(CSCS_NODE);
		expect(computePulseNodes({ computeNode: infomaniak })).toContain(infomaniak);
		expect(computePulseNodes({ computeNode: infomaniak })).not.toContain("cscs");
		expect(computeRevealStages({}, { computeNode: infomaniak })).toEqual(["apertus", infomaniak]);
	});

	it("synthesizes a compute node for a non-Swiss backend too — dark was never the honest answer, only the incomplete one", () => {
		const featherless = backendComputeNode("https://api.featherless.ai/v1");
		expect(featherless).toBe("compute:api.featherless.ai");
		expect(computeRevealStages({}, { computeNode: featherless })).toEqual(["apertus", featherless]);
	});

	it("lights no compute cell before the backend is known, rather than lighting one on faith", () => {
		// Mid-stream, and on any lane whose gateway reports no backend header at all.
		expect(backendComputeNode(undefined)).toBeUndefined();
		// Still dark post-synthesis — the router and gateway hosts below are our own routing
		// hosts, explicitly excluded (NOT_A_BACKEND), never a nameable institution. (CUR-1124)
		expect(backendComputeNode("https://router.huggingface.co/v1")).toBeUndefined();
		// The GATEWAY's own host is not a backend — reading it as one is the original conflation.
		expect(backendComputeNode("https://api-internal.publicai.co/v1")).toBeUndefined();
	});

	it("pulses the compute cell only when the answer truly runs on sovereign compute", () => {
		expect(computePulseNodes({ computeNode: CSCS_NODE })).toEqual(["apertus", "cscs"]);
		expect(computePulseNodes({ webGrounded: true, computeNode: CSCS_NODE })).toEqual([
			"apertus",
			"websearch",
			"cscs",
		]);
	});

	it("a second-opinion turn lights the router node too (matches ProvenanceTrace.svelte's inline revealNodes, which this function had drifted from)", () => {
		expect(computeRevealStages({ opinions: [{ model: "x" }] })).toEqual(["apertus", ROUTER_NODE]);
		expect(computeRevealStages({ verdict: { agreement: "high" } })).toEqual([
			"apertus",
			ROUTER_NODE,
		]);
		// router node lands after the compute node, before an output-block safety append — same relative
		// order ProvenanceTrace.svelte uses.
		expect(
			computeRevealStages(
				{ verdict: { agreement: "high" }, outputModeration: { flagged: true } },
				{ computeNode: CSCS_NODE }
			)
		).toEqual(["apertus", "cscs", ROUTER_NODE, "safety"]);
	});

	it("no second opinion → no router node", () => {
		expect(computeRevealStages({})).not.toContain(ROUTER_NODE);
		expect(computeRevealStages({ opinions: [] })).not.toContain(ROUTER_NODE);
	});

	it("lights the SERVED model's node, not the app default, once one is resolved (CUR-1124)", () => {
		const seaLion = modelNodeFor("aisingapore/Qwen-SEA-LION-v4-32B-IT");
		expect(computeRevealStages({}, { modelNode: seaLion })).toEqual([seaLion]);
		expect(computePulseNodes({ modelNode: seaLion })).toEqual([seaLion]);
		// omitted → the existing apertus default, unchanged for every caller that hasn't been updated yet
		expect(computeRevealStages({})).toEqual(["apertus"]);
		expect(computePulseNodes({})).toEqual(["apertus"]);
	});
});

describe("modelNodeFor — the model node id for a measured served model (CUR-1124)", () => {
	it("returns the curated apertus node for an Apertus id, or when nothing was measured", () => {
		expect(modelNodeFor(undefined)).toBe("apertus");
		expect(modelNodeFor("swiss-ai/Apertus-70B-Instruct-2509")).toBe("apertus");
		expect(modelNodeFor("apertus-ai/Apertus-v1.5-8B")).toBe("apertus");
	});

	it("synthesizes a stable, honest node id for any other served model", () => {
		expect(modelNodeFor("aisingapore/Qwen-SEA-LION-v4-32B-IT")).toBe(
			"model:aisingapore-qwen-sea-lion-v4-32b-it"
		);
		expect(modelNodeFor("z-ai/glm-4.6")).toBe("model:z-ai-glm-4-6");
	});
});

describe("stack node-id authority — every authority id exists in stack-map.json", () => {
	it("no dispatcher constant can target a node the map doesn't define", () => {
		const raw = readFileSync(resolve(process.cwd(), "static/data/stack-map.json"), "utf-8");
		const map = JSON.parse(raw) as { layers: { nodes: { id: string }[] }[] };
		const ids = new Set(map.layers.flatMap((l) => l.nodes.map((n) => n.id)));
		for (const id of ALL_STACK_NODE_IDS) {
			expect(ids.has(id), `node id "${id}" is missing from static/data/stack-map.json`).toBe(true);
		}
	});
});
