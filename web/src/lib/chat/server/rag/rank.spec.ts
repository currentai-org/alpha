import { describe, it, expect } from "vitest";
import { rankByCosine } from "./rank";

describe("rankByCosine", () => {
	it("ranks by cosine descending, filtered by minScore, capped at topK", () => {
		const qv = [1, 0];
		const chunks = [
			{ id: "para", vector: [1, 0] }, // cos 1
			{ id: "diag", vector: [1, 1] }, // cos ~0.707
			{ id: "orth", vector: [0, 1] }, // cos 0 — dropped by minScore
		];
		const out = rankByCosine(qv, chunks, 0.5, 5);
		expect(out.map((s) => s.chunk.id)).toEqual(["para", "diag"]);
		expect(out[0].score).toBeCloseTo(1);
		expect(out[1].score).toBeCloseTo(0.7071, 3);
	});

	it("respects topK", () => {
		const qv = [1, 0];
		const chunks = [
			{ id: "a", vector: [1, 0] },
			{ id: "b", vector: [0.9, 0.1] },
			{ id: "c", vector: [0.8, 0.2] },
		];
		expect(rankByCosine(qv, chunks, 0, 2)).toHaveLength(2);
	});

	it("topK <= 0 returns nothing", () => {
		expect(rankByCosine([1, 0], [{ id: "a", vector: [1, 0] }], 0, 0)).toHaveLength(0);
	});

	it("a wrong-DIMENSION vector scores 0 and is dropped (the in-memory dim defense)", () => {
		// cosine() returns 0 on a length mismatch, so a wrong-dim chunk can never rank.
		// (The model-IDENTITY guard — same dim, different embedding model — is enforced
		// upstream: in SQL for the admin store, and index.model===embeddingModel() for the
		// committed store; see localStore.spec.ts.)
		const qv = [1, 0, 0];
		const chunks = [{ id: "wrong-dim", vector: [1, 0] }];
		expect(rankByCosine(qv, chunks, 0.01, 5)).toHaveLength(0);
	});
});
