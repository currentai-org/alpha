import { describe, it, expect } from "vitest";
import { buildProvenanceFacts, previousServedRecord } from "./provenanceFacts";
import { hardenLastUserTurn } from "./grounding";
import { buildPersonaPrompt, PROVENANCE_DEFERRED_SERVING_CLAUSE } from "./persona";
import type { EndpointMessage } from "../endpoints/types";

// The facts block's first line (provenanceFacts.ts, CUR-3771).
const PROVENANCE_FACTS_HEADER = "Background about you for this turn, never part of your reply:";

const APERTUS = "swiss-ai/Apertus-70B-Instruct-2509";
const GATEWAY = { providerLabel: "the Public AI Inference Utility", namesSwitzerland: false };

describe("buildProvenanceFacts (CUR-1435)", () => {
	it("names the model and maker, and no host for this turn, on any lane (CUR-3562)", () => {
		const facts = buildProvenanceFacts({ modelId: APERTUS });
		expect(facts).toContain("You are Apertus");
		expect(facts).toContain("Swiss National AI Institute");
		expect(facts).toContain("cannot know which provider or machine is answering now");
		expect(facts).toContain("do not add a line about where the answer ran");
		// With no answer for "who serves you", a model puts the operator there. (CUR-4079)
		expect(facts).toContain("an inference provider chosen for each request serves you");
		expect(facts).toContain("AI Potluck and Current AI do not serve you");
		// With "provenance" in the block, a model can write its own "Provenance: Served by"
		// line, and telling it not to in those words does not stop it. (CUR-3771)
		expect(facts).not.toMatch(/provenance|served by/i);
		// A configured host reads as this turn's record and is wrong whenever a direct lane or a
		// fallback served it, which is how "sovereign infrastructure" could reach an Infomaniak turn (CUR-2135).
		expect(facts).not.toMatch(/sovereign infrastructure|in Switzerland|in France|Inference Utility|directly to/);
	});

	it("states the previous answer's MEASURED backend, and says this answer may differ", () => {
		const facts = buildProvenanceFacts({
			modelId: APERTUS,
			previous: { model: APERTUS, backend: "https://api.featherless.ai/v1" },
		});
		expect(facts).toContain("previous answer in this conversation ran on Featherless (United States)");
		expect(facts).toContain("this answer may run elsewhere");
	});

	it("names the previous model too when a different one served it (a failover)", () => {
		const facts = buildProvenanceFacts({
			modelId: APERTUS,
			previous: { model: "zai-org/GLM-5.3", backend: "https://api.infomaniak.com/v1" },
		});
		expect(facts).toMatch(/ran on Infomaniak \(Switzerland\), answered by GLM[^;]*;/);
	});

	it("says nothing about a previous backend nobody has vetted, rather than printing its raw host", () => {
		const facts = buildProvenanceFacts({
			modelId: APERTUS,
			previous: { model: APERTUS, backend: "https://internal-host.example/v1" },
		});
		expect(facts).not.toContain("previous answer");
		expect(facts).not.toContain("internal-host");
	});
});

describe("previousServedRecord", () => {
	it("returns the newest assistant record, skipping the in-progress message with none", () => {
		const rec = previousServedRecord([
			{ from: "assistant", routerMetadata: { model: "a", backend: "old" } },
			{ from: "user" },
			{ from: "assistant", routerMetadata: { model: "b", backend: "new" } },
			{ from: "user" },
			{ from: "assistant" },
		]);
		expect(rec).toEqual({ model: "b", backend: "new" });
	});

	it("returns undefined on a first turn", () => {
		expect(previousServedRecord([{ from: "user" }, { from: "assistant" }])).toBeUndefined();
	});
});

describe("wiring", () => {
	it("hardenLastUserTurn puts the facts in the user turn outside the fence, on a question the serving word list misses", async () => {
		const facts = buildProvenanceFacts({ modelId: APERTUS });
		const msgs = [{ from: "user", content: "Which model are you, and who runs it?" }] as EndpointMessage[];
		await hardenLastUserTurn(msgs, { ...GATEWAY, isSovereign: true }, undefined, undefined, facts);
		const content = msgs[0].content ?? "";
		const fenceOpen = content.search(/\n\n<Q_[0-9a-f]{8}>\n/);
		expect(content.indexOf(PROVENANCE_FACTS_HEADER)).toBeGreaterThan(-1);
		expect(content.indexOf(PROVENANCE_FACTS_HEADER)).toBeLessThan(fenceOpen);
		// Replaces the regex-gated note rather than stacking a second, contradicting serving claim.
		expect(content).not.toContain("sovereign infrastructure");
	});

	it("with the flag off (no facts passed), the user turn is unchanged from today's behaviour", async () => {
		const msgs = [{ from: "user", content: "Which model are you, and who runs it?" }] as EndpointMessage[];
		await hardenLastUserTurn(msgs, { ...GATEWAY, isSovereign: true });
		expect(msgs[0].content).not.toContain(PROVENANCE_FACTS_HEADER);
	});

	it("the persona defers the serving claim to the per-turn facts instead of asserting sovereign infrastructure", () => {
		const serving = { ...GATEWAY, isSovereign: true };
		const deferred = buildPersonaPrompt(APERTUS, undefined, { serving, deferServing: true });
		expect(deferred).toContain(PROVENANCE_DEFERRED_SERVING_CLAUSE);
		expect(deferred).not.toContain("sovereign infrastructure");
		expect(buildPersonaPrompt(APERTUS, undefined, { serving })).toContain("sovereign infrastructure");
	});
});
