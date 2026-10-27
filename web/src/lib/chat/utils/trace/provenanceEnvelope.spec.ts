import { describe, it, expect } from "vitest";
import { buildProvenanceEnvelope, PROVENANCE_SCHEMA } from "./provenanceEnvelope";
import type { Message } from "$lib/chat/types/Message";

const MODEL = "swiss-ai/Apertus-70B-Instruct-2509";
const SERVING = {
	providerLabel: "CSCS",
	isSovereign: true,
	servedCheckpoint: "Apertus-70B-Instruct-2509",
};
// Loose fixtures: SearchSource/RagSource carry more fields than these probes need, so accept
// `unknown`-shaped partials and cast through unknown (the serializer's real type safety is its
// Message signature, exercised by the production call site).
const msg = (p: Record<string, unknown>): Message =>
	({ from: "assistant", id: "m1", content: "an answer", ...p }) as unknown as Message;

describe("buildProvenanceEnvelope", () => {
	it("carries schema, message id, real model identity, and serving host", () => {
		const e = buildProvenanceEnvelope(msg({}), MODEL, SERVING);
		expect(e.schema).toBe(PROVENANCE_SCHEMA);
		expect(e.messageId).toBe("m1");
		expect(e.model).toMatchObject({
			name: "Apertus 70B",
			maker: "SNAI",
			openness: "fully open",
		});
		expect(e.served).toEqual({
			provider: "CSCS",
			sovereign: true,
			checkpoint: SERVING.servedCheckpoint,
		});
	});

	// Regression pin: the envelope must resolve identity from what answered, not from the conversation's
	// REQUESTED id, or it could not report a backup lane's substitution; `served.backend` is the only
	// measured field in it. Reading `modelId` again must turn the first case red naming
	// GLM; if it stays green the assertion pins the request.
	it("reports the model that ANSWERED, not the one requested, when the gateway measured one", () => {
		const e = buildProvenanceEnvelope(
			msg({ routerMetadata: { model: "zai-org/GLM-5.2", backend: "https://api.example/v1" } }),
			MODEL,
			SERVING
		);
		expect(e.model.id).toBe("zai-org/GLM-5.2");
		expect(e.model.id).not.toBe(MODEL);
		expect(e.model.measured).toBe(true);
		// identity is derived from the served id too, so the maker cannot keep saying SNAI
		expect(e.model.maker).not.toBe("SNAI");
	});

	it("falls back to the requested id and says measured:false when no provenance header arrived", () => {
		const e = buildProvenanceEnvelope(msg({}), MODEL, SERVING);
		expect(e.model.id).toBe(MODEL);
		expect(e.model.measured).toBe(false);
		// absence is unconfirmed, never a mismatch — pages-on-silence is the failure mode this avoids
		expect(e.model.maker).toBe("SNAI");
	});

	it("numbers combined RAG[1..k]+web[k+1..] sources in citation order (community-first, matches server)", () => {
		const e = buildProvenanceEnvelope(
			msg({
				webSearch: {
					query: "q",
					asOf: "2026-06-24",
					sources: [
						{ title: "Wiki", url: "https://w", snippet: "", engine: "wikipedia" },
						{ title: "Marg", url: "https://m", snippet: "", engine: "firecrawl" },
					],
				},
				rag: {
					query: "q",
					asOf: "2026-06-24",
					sources: [{ title: "Cat", url: undefined, snippet: "", engine: "Potluck" }],
				},
			}),
			MODEL,
			SERVING
		);
		expect(e.grounding.grounded).toBe(true);
		expect(e.grounding.web).toEqual({ count: 2, engines: ["wikipedia", "firecrawl"] });
		expect(e.grounding.sources).toEqual([
			{ n: 1, title: "Cat", url: null, engine: "Potluck" }, // RAG/community first; url-less → null, still numbered
			{ n: 2, title: "Wiki", url: "https://w", engine: "wikipedia" },
			{ n: 3, title: "Marg", url: "https://m", engine: "firecrawl" },
		]);
	});

	it("an ungrounded answer is grounded:false with no sources", () => {
		const e = buildProvenanceEnvelope(msg({ content: "Bern is the capital." }), MODEL, SERVING);
		expect(e.grounding.grounded).toBe(false);
		expect(e.grounding.sources).toEqual([]);
		expect(e.answer.disposition).toBe("answered");
	});

	it("labels a model self-decline (not a safety-layer block)", () => {
		const e = buildProvenanceEnvelope(
			msg({ content: "I'm sorry, but I cannot assist with that for safety reasons." }),
			MODEL,
			SERVING
		);
		expect(e.answer.disposition).toBe("self-declined");
		expect(e.answer.declinedBySafetyLayer).toBe(false);
	});

	it("distinguishes a SAFETY-LAYER block (model never ran) from a self-decline", () => {
		const e = buildProvenanceEnvelope(
			msg({ content: "blocked", moderation: { flagged: true } }),
			MODEL,
			SERVING
		);
		expect(e.answer.declinedBySafetyLayer).toBe(true);
		expect(e.answer.screen).toBe("flagged");
		expect(e.answer.disposition).toBe("answered"); // disposition never applies to a layer block
	});

	it("reflects cache-served and second-opinion flags", () => {
		const cached = buildProvenanceEnvelope(msg({ servedFromCache: true }), MODEL, SERVING);
		expect(cached.answer.servedFromCache).toBe(true);
		const verified = buildProvenanceEnvelope(msg({ opinions: [{ model: "x" }] }), MODEL, SERVING);
		expect(verified.secondOpinion).toBe(true);
	});
});
