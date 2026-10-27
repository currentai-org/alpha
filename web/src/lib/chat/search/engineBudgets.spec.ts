import { describe, it, expect } from "vitest";
import {
	resolveEngineBudgets,
	WIDE_NET_DEFAULTS,
	RERANK_BATCH_CAP,
	type EngineBudgets,
} from "./engineBudgets";
import { SPECIALIZED_INTENTS, type SearchIntent } from "./queryIntent";

const sum = (b: EngineBudgets) =>
	b.wikipedia + b.wikinews + b.firecrawl + b.openalex + b.arxiv + b.huggingface;

// Every subset of the four specialized intents (for exhaustive secondary-signal combos).
function allSignalSubsets(): Set<SearchIntent>[] {
	const out: Set<SearchIntent>[] = [];
	for (let mask = 0; mask < 1 << SPECIALIZED_INTENTS.length; mask++) {
		const s = new Set<SearchIntent>();
		SPECIALIZED_INTENTS.forEach((intent, i) => {
			if (mask & (1 << i)) s.add(intent);
		});
		out.push(s);
	}
	return out;
}

describe("resolveEngineBudgets", () => {
	it("not confident (or general) → today's exact wide-net defaults (zero regression)", () => {
		expect(resolveEngineBudgets({ intent: "general", confident: false, signals: new Set() })).toEqual(
			WIDE_NET_DEFAULTS
		);
		// A confident-looking call for `general` is impossible from the classifier, but guard it anyway.
		expect(
			resolveEngineBudgets({ intent: "news", confident: false, signals: new Set(["news"]) })
		).toEqual(WIDE_NET_DEFAULTS);
	});

	it("sum ≤ 32 for EVERY confident intent × secondary-signal subset (batch cap holds after rescue)", () => {
		for (const intent of SPECIALIZED_INTENTS) {
			for (const signals of allSignalSubsets()) {
				signals.add(intent); // the primary is always present
				const b = resolveEngineBudgets({ intent, confident: true, signals });
				expect(sum(b), `${intent} + ${[...signals].join(",")}`).toBeLessThanOrEqual(
					RERANK_BATCH_CAP
				);
				// Rebalance never shrinks the general-web engines below the floor of 3.
				expect(b.firecrawl).toBeGreaterThanOrEqual(3);
				expect(b.wikipedia).toBeGreaterThanOrEqual(3);
				// No negative budgets.
				for (const v of Object.values(b)) expect(v).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it("rescues HF to the wide-net default (4) when a models signal is present on a non-models intent", () => {
		// news alone drops HF to 0…
		expect(
			resolveEngineBudgets({ intent: "news", confident: true, signals: new Set(["news"]) })
				.huggingface
		).toBe(0);
		// …but news + a models signal keeps HF ≥ 4 (mixed intent; e.g. "latest open-weights
		// release").
		expect(
			resolveEngineBudgets({
				intent: "news",
				confident: true,
				signals: new Set(["news", "models"]),
			}).huggingface
		).toBeGreaterThanOrEqual(WIDE_NET_DEFAULTS.huggingface);
	});

	it("rescues OpenAlex + arXiv to the wide-net default (5) when a research signal is present", () => {
		const b = resolveEngineBudgets({
			intent: "news",
			confident: true,
			signals: new Set(["news", "research"]),
		});
		expect(b.openalex).toBeGreaterThanOrEqual(WIDE_NET_DEFAULTS.openalex);
		expect(b.arxiv).toBeGreaterThanOrEqual(WIDE_NET_DEFAULTS.arxiv);
	});

	it("does NOT zero HF on a reference query that also carries a models signal", () => {
		expect(
			resolveEngineBudgets({
				intent: "reference",
				confident: true,
				signals: new Set(["reference", "models"]),
			}).huggingface
		).toBeGreaterThanOrEqual(WIDE_NET_DEFAULTS.huggingface);
	});

	it("models intent already gives scholarly engines ≥ their defaults (no rescue needed)", () => {
		const b = resolveEngineBudgets({
			intent: "models",
			confident: true,
			signals: new Set(["models", "research"]),
		});
		expect(sum(b)).toBeLessThanOrEqual(RERANK_BATCH_CAP);
		expect(b.huggingface).toBeGreaterThan(0);
	});
});
