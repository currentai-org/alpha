import { describe, it, expect } from "vitest";
import { deriveRequestTrace } from "./requestTrace";
import type { Message } from "$lib/chat/types/Message";

const base = (over: Partial<Message> = {}): Message =>
	({ id: "m1", from: "assistant", content: "an answer", ...over }) as Message;

const ids = (m: Message) => deriveRequestTrace(m).map((s) => s.id);
// Tolerant lookup — returns undefined when the step is absent (used with ?. where absence is valid).
const step = (m: Message, id: string) => deriveRequestTrace(m).find((s) => s.id === id);
// Definite lookup — asserts the step is present and narrows the type, for the cases that REQUIRE it.
const requireStep = (m: Message, id: string) => {
	const s = step(m, id);
	if (!s) throw new Error(`expected request-trace step "${id}" to be present`);
	return s;
};

describe("deriveRequestTrace — honest order + gating", () => {
	it("ungrounded turn: safety runs FIRST, then inference/guards/persist; no retrieval", () => {
		expect(ids(base())).toEqual([
			"received",
			"history",
			"safety",
			"inference",
			"guards",
			"persist",
		]);
	});

	it("safety precedes retrieval (it screens BEFORE search/RAG in the real pipeline)", () => {
		const m = base({
			webSearch: {
				query: "x",
				asOf: "2026-06-23",
				sources: [
					{ n: 1, title: "A", url: "https://en.wikipedia.org/a", snippet: "", engine: "Wikipedia" },
					{
						n: 2,
						title: "B",
						url: "https://example.com/b",
						snippet: "",
						engine: "Firecrawl",
					},
				],
			},
		});
		const order = ids(m);
		expect(order.indexOf("safety")).toBeLessThan(order.indexOf("websearch"));
		expect(order.indexOf("websearch")).toBeLessThan(order.indexOf("inference"));
		const ws = requireStep(m, "websearch");
		expect(ws.node).toBe("websearch");
		expect(ws.response).toBe("2 sources · Wikipedia, Firecrawl");
		expect(ws.productAttribution).toBe("Firecrawl");
	});

	it("self-declined turn: sources were attached but never used — no websearch/rag step (the OTC-dose case)", () => {
		const m = base({
			content:
				"I cannot help with that. Please consult your doctor for guidance on the correct dose.",
			webSearch: {
				query: "dose",
				asOf: "2026-06-30",
				sources: [
					{
						n: 1,
						title: "Dosage",
						url: "https://en.wikipedia.org/dose",
						snippet: "",
						engine: "Wikipedia",
					},
					{
						n: 2,
						title: "Unrelated drug",
						url: "https://en.wikipedia.org/x",
						snippet: "",
						engine: "Wikipedia",
					},
				],
			},
			rag: {
				sources: [
					{
						n: 3,
						title: "Potluck doc",
						url: "https://x",
						snippet: "",
						engine: "Potluck:Community",
					},
				],
			},
		} as Partial<Message>);
		expect(step(m, "websearch")).toBeUndefined();
		expect(deriveRequestTrace(m).find((s) => s.id.startsWith("rag-"))).toBeUndefined();
		// the model still ran (it's not a layer decline) — inference + the honest disposition note remain
		expect(step(m, "inference")).toBeDefined();
		expect(step(m, "disposition")?.detail).toMatch(/declined this itself/);
	});

	it("a normal answered turn with sources keeps the websearch/rag steps (no regression)", () => {
		const m = base({
			content: "Here is the answer [1].",
			webSearch: {
				query: "x",
				asOf: "2026-06-30",
				sources: [
					{ n: 1, title: "A", url: "https://en.wikipedia.org/a", snippet: "", engine: "Wikipedia" },
				],
			},
		} as Partial<Message>);
		expect(step(m, "websearch")).toBeDefined();
	});

	it("a search that ran but never grounded the turn gets an honest ungrounded step, not silence", () => {
		const m = base({ searchAttempt: { grounded: false, searched: true } } as Partial<Message>);
		const ws = requireStep(m, "websearch-ungrounded");
		expect(ws.node).toBeNull();
		expect(ws.response).toBe("no source used");
		expect(ws.detail).toMatch(/no result cleared the relevance bar/);
		// mutually exclusive with the grounded step
		expect(step(m, "websearch")).toBeUndefined();
		const order = ids(m);
		expect(order.indexOf("safety")).toBeLessThan(order.indexOf("websearch-ungrounded"));
		expect(order.indexOf("websearch-ungrounded")).toBeLessThan(order.indexOf("inference"));
	});

	it("the margin gate declining to search at all gets distinct, lighter-weight copy (no fake round-trip claim)", () => {
		const m = base({ searchAttempt: { grounded: false, searched: false } } as Partial<Message>);
		const ws = requireStep(m, "websearch-ungrounded");
		expect(ws.response).toBe("search skipped");
		expect(ws.detail).toMatch(/decided it wasn't necessary/);
		expect(ws.detail).not.toMatch(/no result cleared the relevance bar/);
	});

	it("no ungrounded-search step when no search ran at all (plain training-only turn)", () => {
		expect(step(base(), "websearch-ungrounded")).toBeUndefined();
	});

	it("a grounded search takes priority: searchAttempt alongside webSearch never double-shows", () => {
		const m = base({
			searchAttempt: { grounded: false, searched: true },
			webSearch: {
				query: "x",
				asOf: "2026-06-30",
				sources: [{ n: 1, title: "A", url: "https://en.wikipedia.org/a", snippet: "", engine: "Wikipedia" }],
			},
		} as Partial<Message>);
		expect(step(m, "websearch")).toBeDefined();
		expect(step(m, "websearch-ungrounded")).toBeUndefined();
	});

	it("self-declined turn: an ungrounded search attempt stays silent too (sources were never used)", () => {
		const m = base({
			content:
				"I cannot help with that. Please consult your doctor for guidance on the correct dose.",
			searchAttempt: { grounded: false, searched: true },
		} as Partial<Message>);
		expect(step(m, "websearch-ungrounded")).toBeUndefined();
	});

	it("community-first: RAG steps precede the open-web step when a turn has both", () => {
		const m = base({
			rag: {
				sources: [
					{
						n: 1,
						title: "Potluck doc",
						url: "https://x",
						snippet: "",
						engine: "Potluck:Community",
					},
				],
			},
			webSearch: {
				query: "x",
				asOf: "2026-06-28",
				sources: [
					{ n: 2, title: "A", url: "https://en.wikipedia.org/a", snippet: "", engine: "Wikipedia" },
				],
			},
		} as Partial<Message>);
		const order = ids(m);
		const rag = order.findIndex((id) => id.startsWith("rag-"));
		expect(rag).toBeGreaterThanOrEqual(0);
		expect(rag).toBeLessThan(order.indexOf("websearch"));
	});

	it("rag retrieval names the actual sources (not a bare 'N sources'), capped at two + more", () => {
		const m = base({
			rag: {
				sources: [
					{
						n: 1,
						title: "Federated learning 101",
						url: "https://x",
						snippet: "",
						engine: "Potluck:Community",
					},
					{
						n: 2,
						title: "Open weights explainer",
						url: "https://y",
						snippet: "",
						engine: "Potluck:Community",
					},
					{ n: 3, title: "Third doc", url: "https://z", snippet: "", engine: "Potluck:Community" },
				],
			},
		} as Partial<Message>);
		const rag = deriveRequestTrace(m).find((s) => s.id.startsWith("rag-"));
		if (!rag) throw new Error('expected a "rag-*" step to be present');
		expect(rag.layer).toBe("retrieval");
		expect(rag.response).toBe(
			"3 sources · Federated learning 101, Open weights explainer, +1 more"
		);
	});

	it("rag naming de-dupes a repeated title instead of showing it twice (live bug: 4 sources, 2 chunks of the same doc)", () => {
		const m = base({
			rag: {
				sources: [
					{ n: 1, title: "Fund currentai org", url: "https://x", snippet: "", engine: "Potluck:Community" },
					{ n: 2, title: "Fund currentai org", url: "https://x", snippet: "", engine: "Potluck:Community" },
					{ n: 3, title: "About page", url: "https://y", snippet: "", engine: "Potluck:Community" },
					{ n: 4, title: "Roadmap", url: "https://z", snippet: "", engine: "Potluck:Community" },
				],
			},
		} as Partial<Message>);
		const rag = deriveRequestTrace(m).find((s) => s.id.startsWith("rag-"));
		if (!rag) throw new Error('expected a "rag-*" step to be present');
		// Two distinct titles named ("Fund currentai org" once, not twice), and the "+more" count reflects
		// only the sources NOT covered by either named title (1: "Roadmap"), not a naive 4-2=2.
		expect(rag.response).toBe("4 sources · Fund currentai org, About page, +1 more");
	});

	it("each RAG engine gets its own step with a distinct, non-generic detail (not a shared 'found snippets' line)", () => {
		const m = base({
			rag: {
				sources: [
					{ n: 1, title: "Catalog doc", url: "https://x", snippet: "", engine: "Potluck" },
					{ n: 2, title: "Uploaded doc", url: "https://y", snippet: "", engine: "Potluck:Community" },
				],
			},
		} as Partial<Message>);
		const steps = deriveRequestTrace(m).filter((s) => s.id.startsWith("rag-"));
		expect(steps).toHaveLength(2);
		const [catalog, community] = steps;
		expect(catalog.title).toBe("Retrieval · the Potluck catalog");
		expect(community.title).toBe("Retrieval · docs the team uploaded");
		expect(catalog.detail).not.toBe(community.detail);
		// Each step also carries the engine it actually hit, so a UI consumer can filter
		// message.rag.sources down to exactly what THIS step's count refers to.
		expect(catalog.engine).toBe("Potluck");
		expect(community.engine).toBe("Potluck:Community");
	});

	it("a declined turn stops after safety — no retrieval, no inference, no persist", () => {
		const m = base({
			moderation: {
				flagged: true,
				label: "chat-block-violence",
				score: 0.9,
				kind: "content_policy",
				ruleLabel: "Violence policy",
			},
			webSearch: {
				query: "x",
				asOf: "2026-06-23",
				sources: [{ n: 1, title: "A", url: "https://a", snippet: "", engine: "Wikipedia" }],
			},
		});
		expect(ids(m)).toEqual(["received", "history", "safety", "declined"]);
		// the CURATED rule label is surfaced — never the raw action code in `label`
		expect(step(m, "safety")?.response).toMatch(/flagged \(Violence policy\) — answer withheld/);
		expect(step(m, "safety")?.response).not.toContain("chat-block-violence");
	});

	it("an answer the output guard could not check reads as unchecked in the trace, never as flagged (CUR-3891)", () => {
		const out = (unscreened: boolean) =>
			step(
				base({
					// The decline is what is saved as the answer.
					content: "I wrote an answer but couldn't finish its safety check.",
					outputModeration: {
						flagged: true,
						label: "child_safety",
						score: 1,
						kind: "child_safety",
						screened: true,
						...(unscreened ? { unscreened: true } : {}),
					},
				}),
				"output-screen"
			)?.response;
		expect(out(true)).toBe("check could not finish — answer withheld");
		expect(out(false)).toBe("flagged — answer withheld");
	});

	it("a declined turn with NO curated label surfaces no rule name (never the raw code)", () => {
		const m = base({
			moderation: {
				flagged: true,
				label: "chat-block-secret-rule",
				score: 1,
				kind: "content_policy",
			},
		});
		const resp = step(m, "safety")?.response ?? "";
		expect(resp).toMatch(/^flagged — answer withheld$/);
		expect(resp).not.toContain("chat-block-secret-rule");
	});
});

describe("deriveRequestTrace — the safety step never overclaims (toxic-bert fails open)", () => {
	it("no screen signal → 'no flag raised' (never 'passed')", () => {
		const s = requireStep(base(), "safety");
		expect(s.response).toBe("no flag raised");
		expect(s.status).toBe("ok");
	});

	it("recorded clear screen → 'screened, no flag raised'", () => {
		const m = base({
			moderation: { flagged: false, label: null, score: 0.01, kind: "toxicity", screened: true },
		});
		expect(step(m, "safety")?.response).toBe("screened, no flag raised");
	});

	it("failed-open screen → honest 'screening unavailable' + status failed-open", () => {
		const m = base({
			moderation: { flagged: false, label: null, score: 0, kind: "toxicity", screened: false },
		});
		const s = requireStep(m, "safety");
		expect(s.status).toBe("failed-open");
		expect(s.response).toMatch(/screening unavailable.*failed open/);
	});
});

describe("deriveRequestTrace — evidence gating", () => {
	it("cache-served turn: short honest trace, no fabricated pipeline (no model run)", () => {
		const m = base({ servedFromCache: true });
		expect(ids(m)).toEqual(["received", "cache"]);
		expect(ids(m)).not.toContain("inference");
		expect(ids(m)).not.toContain("safety");
	});

	it("interrupted generation is marked, not asserted as a clean completion", () => {
		const m = base({ interrupted: true });
		expect(step(m, "inference")?.status).toBe("interrupted");
	});

	it("no inference/persist step when there is no answer content", () => {
		const m = base({ content: "" });
		expect(ids(m)).not.toContain("inference");
		expect(ids(m)).not.toContain("persist");
	});

	it("no timing recorded → every step's timingMs is null (never fabricated)", () => {
		for (const s of deriveRequestTrace(
			base({ webSearch: { query: "q", asOf: "d", sources: [] } })
		)) {
			expect(s.timingMs).toBeNull();
		}
	});

	it("real timings land ONLY on inference (TTFT) and persist (total); other steps stay null", () => {
		const all = deriveRequestTrace(base({ timings: { ttftMs: 128, totalMs: 905 } }));
		expect(all.find((s) => s.id === "inference")?.timingMs).toBe(128);
		expect(all.find((s) => s.id === "persist")?.timingMs).toBe(905);
		for (const s of all) {
			if (s.id !== "inference" && s.id !== "persist") expect(s.timingMs).toBeNull();
		}
	});
});

describe("deriveRequestTrace — no invented components", () => {
	it("emits no standalone 'route' step and links nothing to a router that didn't run", () => {
		const all = deriveRequestTrace(
			base({
				webSearch: {
					query: "q",
					asOf: "d",
					sources: [{ n: 1, title: "A", url: "https://a", snippet: "", engine: "Wikipedia" }],
				},
			})
		);
		expect(all.find((s) => s.id === "route")).toBeUndefined();
		expect(all.some((s) => s.node === "router")).toBe(false);
	});

	it("guards report only real corrections; nothing about recency hedges", () => {
		expect(step(base(), "guards")?.response).toBe("no corrections made");
		expect(step(base(), "guards")?.detail).not.toMatch(/hedge/i);
		const m = base({ urlNotice: { count: 2 } });
		// "flagged", not "de-linked": the link is kept clickable + marked, matching the UrlNotice chip.
		expect(step(m, "guards")?.response).toMatch(/flagged 2 unverified links/);
		// sourceGuard strip must be reported, not silent.
		const s = base({ sourceNotice: { removedChars: 120 } });
		expect(step(s, "guards")?.response).toMatch(/fabricated source list/);
		// groundedHedgeReplacement discarding the whole answer must be reported too, not left to
		// Axiom's logger.info with "no corrections made" shown over text the model never wrote (CUR-148).
		const g = base({ groundedHedgeNotice: { kind: "pointer", sourceCount: 2 } });
		expect(step(g, "guards")?.response).toMatch(/pointer to 2 retrieved sources/);
		const gNoSources = base({ groundedHedgeNotice: { kind: "pointer", sourceCount: 0 } });
		expect(step(gNoSources, "guards")?.response).toMatch(/pointer to retrieved reference material/);
		// The ungrounded-regen path (groundedBailRegen.ts) gets its own honest copy — a real answer, not a
		// citation dump, so the disclosure must not claim it points at anything.
		const regen = base({ groundedHedgeNotice: { kind: "regen", sourceCount: 2 } });
		expect(step(regen, "guards")?.response).toMatch(/answered from what it already knows/);
		expect(step(regen, "guards")?.response).not.toMatch(/pointer/);
	});

	it("says a fact check that never finished was not checked, and shows no fact check where none ran (CUR-2765)", () => {
		expect(ids(base())).not.toContain("groundcheck");
		const timedOut = step(base({ groundcheckNotice: { outcome: "detect-failed" } }), "groundcheck");
		expect(timedOut?.response).toMatch(/^not checked/);
		expect(timedOut?.status).toBe("failed-open");
		const revised = step(base({ groundcheckNotice: { outcome: "revised" } }), "groundcheck");
		expect(revised?.response).toMatch(/removed claims no source supports/);
		expect(revised?.status).toBe("ok");
		// The stamp's count, in the row; one without a count (stamped earlier) keeps the plain line. (CUR-2927)
		expect(step(base({ groundcheckNotice: { outcome: "revised", removed: 1 } }), "groundcheck")?.response).toBe("removed 1 claim no source supports");
		expect(step(base({ groundcheckNotice: { outcome: "revised", removed: 3 } }), "groundcheck")?.response).toBe("removed 3 claims no source supports");
		expect(step(base({ groundcheckNotice: { outcome: "clean" } }), "groundcheck")?.response).toBe("checked, nothing removed");
		expect(step(base({ groundcheckNotice: { outcome: "stood-down" } }), "groundcheck")?.response).toMatch(/^not checked: its figures came from code/);
	});

	it("adds a 'What the model did' step only when the answer isn't a clean answer", () => {
		expect(ids(base())).not.toContain("disposition");
		const refused = base({
			content:
				"I'm sorry, but I cannot assist with that request. For safety reasons, I cannot provide guidance.",
		});
		const order = ids(refused);
		expect(order).toContain("disposition");
		expect(order.indexOf("disposition")).toBeGreaterThan(order.indexOf("inference"));
		expect(order.indexOf("disposition")).toBeLessThan(order.indexOf("persist"));
		expect(step(refused, "disposition")?.detail).toMatch(/declined this itself/);
		expect(step(refused, "disposition")?.node).toBeNull();
	});

	it("second opinion is shown last and labeled a separate later request", () => {
		const m = base({
			opinions: [{ model: "x", modelShort: "X", openness: "open", sovereign: false, answer: "" }],
			verdict: {
				agreement: "high",
				headline: "",
				consensus: [],
				contradictions: [],
				weakSpots: [],
			},
		});
		const order = ids(m);
		expect(order.indexOf("second-opinion")).toBeGreaterThan(order.indexOf("persist"));
		expect(step(m, "second-opinion")?.node).toBeNull();
		expect(step(m, "second-opinion")?.title).toMatch(/later/i);
	});

	it("agent tool execution gets its own step adjacent to inference (CUR-601)", () => {
		const m = base({ agentTools: { toolKinds: ["write_file", "terminal"] } });
		const order = ids(m);
		expect(order).toContain("agent-tools");
		expect(order.indexOf("inference")).toBeLessThan(order.indexOf("agent-tools"));
		expect(order.indexOf("agent-tools")).toBeLessThan(order.indexOf("guards"));
		expect(step(m, "agent-tools")?.node).toBeNull();
		expect(step(m, "agent-tools")?.response).toBe("write_file, terminal");
	});

	// A message WITH counts renders the structural summary, not the flat kind list: proves the ternary in
	// deriveRequestTrace reaches summarizeToolRun and picks the right branch, not just that the fallback path
	// still works (the test above) (CUR-775).
	it("agent tool execution renders the structural summary when counts is present (CUR-775)", () => {
		const m = base({
			agentTools: { toolKinds: ["edit", "execute"], counts: { edit: 2, execute: 1 } },
		});
		expect(step(m, "agent-tools")?.response).toBe("Edited 2 files, ran 1 command");
	});

	it("no agent-tools step when message.agentTools is absent or empty", () => {
		expect(ids(base())).not.toContain("agent-tools");
		expect(ids(base({ agentTools: { toolKinds: [] } }))).not.toContain("agent-tools");
	});
});

// CUR-2239. A backup model answered after the primary did not. The receipt has to name both: the
// inference step alone credits only the backup, which hid that the turn started on the primary.
describe("deriveRequestTrace — a failover names both models", () => {
	const failover = {
		from: "swiss-ai/apertus-v1.5-70b",
		to: "zai-org/GLM-5.3",
		reason: "unavailable" as const,
	};

	it("puts a failover step naming the primary right before the backup's inference step", () => {
		const m = base({ failover, routerMetadata: { route: "", model: "zai-org/GLM-5.3" } });
		const order = ids(m);
		expect(order.indexOf("failover")).toBe(order.indexOf("inference") - 1);
		const f = requireStep(m, "failover");
		expect(f.title).toBe("Apertus 1.5 70B · didn't answer");
		expect(f.response).toBe("switched to GLM 5.3");
		expect(requireStep(m, "inference").title).toBe("Inference · GLM 5.3");
	});

	it("says skipped, not failed, when a test fault took the primary out", () => {
		const f = requireStep(base({ failover: { ...failover, reason: "skipped" } }), "failover");
		expect(f.title).toBe("Apertus 1.5 70B · skipped");
		expect(f.detail).toMatch(/test fault/);
	});

	it("has no failover step on a turn the primary served", () => {
		expect(ids(base())).not.toContain("failover");
	});
});
