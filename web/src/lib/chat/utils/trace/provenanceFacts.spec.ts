import { describe, it, expect } from "vitest";
import { provenanceFacts } from "./provenanceFacts";
import type { Message } from "$lib/chat/types/Message";

const m = (over: Partial<Message> = {}): Message =>
	({ id: "m1", from: "assistant", content: "a", ...over }) as Message;

describe("provenanceFacts — one definition of what happened this turn", () => {
	it("does not count a fixed reply as answered, so X-ray credits no model with text no model wrote (CUR-2954)", () => {
		for (const kind of ["canned", "capacity", "missing-document", "low-resource-language"] as const) {
			const f = provenanceFacts(m({ content: "No model wrote this.", fixedReply: { kind } }));
			expect(f.answered, kind).toBe(false);
		}
		expect(provenanceFacts(m({ content: "Bern is the capital." })).answered).toBe(true);
	});

	it("declined keys on moderation.flagged; screen = flagged", () => {
		const f = provenanceFacts(
			m({ moderation: { flagged: true, label: "t", score: 1, kind: "toxicity" } })
		);
		expect(f.declined).toBe(true);
		expect(f.screen).toBe("flagged");
	});

	it("screen state distinguishes clear / failed-open / unknown", () => {
		expect(provenanceFacts(m()).screen).toBe("unknown");
		expect(
			provenanceFacts(
				m({
					moderation: { flagged: false, label: null, score: 0, kind: "toxicity", screened: true },
				})
			).screen
		).toBe("clear");
		expect(
			provenanceFacts(
				m({
					moderation: { flagged: false, label: null, score: 0, kind: "toxicity", screened: false },
				})
			).screen
		).toBe("failed-open");
	});

	it("output screen: withheld + outputScreen mirror the parallel outputModeration field", () => {
		// off this turn → unknown, not withheld
		const off = provenanceFacts(m());
		expect(off.outputScreen).toBe("unknown");
		expect(off.withheld).toBe(false);
		// ran + flagged → withheld (the model RAN; answer held), distinct from input `declined`
		const blocked = provenanceFacts(
			m({
				outputModeration: { flagged: true, label: "chat-block", score: 1, kind: "content_policy" },
			})
		);
		expect(blocked.withheld).toBe(true);
		expect(blocked.outputScreen).toBe("flagged");
		expect(blocked.declined).toBe(false); // input was NOT flagged — only the output was
		// ran + clear / failed-open
		expect(
			provenanceFacts(
				m({
					outputModeration: {
						flagged: false,
						label: null,
						score: 0,
						kind: "content_policy",
						screened: true,
					},
				})
			).outputScreen
		).toBe("clear");
		expect(
			provenanceFacts(
				m({
					outputModeration: {
						flagged: false,
						label: null,
						score: 0,
						kind: "content_policy",
						screened: false,
					},
				})
			).outputScreen
		).toBe("failed-open");
	});

	it("a withheld answer is NOT given a model disposition (it's a safety hold, not an answer)", () => {
		const f = provenanceFacts(
			m({
				content: "I can't help with that.", // looks like a self-decline, but it's the output-hold copy
				outputModeration: { flagged: true, label: "chat-block", score: 1, kind: "content_policy" },
			})
		);
		expect(f.disposition).toBe("answered"); // skipped via !withheld, like an input decline
	});

	it("grounded = web OR rag OR vault; rag hits carry node + count", () => {
		expect(provenanceFacts(m()).grounded).toBe(false);
		const f = provenanceFacts(
			m({
				rag: {
					query: "q",
					asOf: "d",
					sources: [
						{ n: 1, title: "A", snippet: "", engine: "Potluck" },
						{ n: 2, title: "B", snippet: "", engine: "Potluck" },
						{ n: 3, title: "C", snippet: "", engine: "SyftHub:EPFL" },
						{ n: 4, title: "D", snippet: "", engine: "SyftHub", sourceName: "acme/news" },
					],
				},
			})
		);
		expect(f.grounded).toBe(true);
		expect(f.ragHits.find((h) => h.engine === "Potluck")?.count).toBe(2);
		expect(f.ragHits.find((h) => h.engine === "SyftHub:EPFL")?.node).toBe("syft-epfl");
		// the generic federated engine lights the dedicated SyftHub node (not the catalog node)
		expect(f.ragHits.find((h) => h.engine === "SyftHub")?.node).toBe("syft-rag");
	});

	it("matches the booleans ProvenanceTrace relies on (web/mcp/agentTools/verified/interrupted/cache)", () => {
		const f = provenanceFacts(
			m({
				webSearch: {
					query: "q",
					asOf: "d",
					sources: [{ n: 1, title: "A", url: "https://a", snippet: "", engine: "Wikipedia" }],
				},
				mcp: { tool: "tts" },
				agentTools: { toolKinds: ["write_file"] },
				opinions: [{ model: "x", modelShort: "X", openness: "open", sovereign: false, answer: "" }],
				interrupted: true,
			})
		);
		expect(f.webCount).toBe(1);
		expect(f.mcpRan).toBe(true);
		expect(f.agentToolsRan).toBe(true);
		expect(f.verified).toBe(true);
		expect(f.interrupted).toBe(true);
		expect(provenanceFacts(m({ servedFromCache: true })).servedFromCache).toBe(true);
	});

	it("agentToolsRan is false when message.agentTools is absent or empty", () => {
		expect(provenanceFacts(m()).agentToolsRan).toBe(false);
		expect(provenanceFacts(m({ agentTools: { toolKinds: [] } })).agentToolsRan).toBe(false);
	});

	it("searchAttempted mirrors the presence of message.searchAttempt; searchRan narrows to a real round-trip", () => {
		expect(provenanceFacts(m()).searchAttempted).toBe(false);
		expect(provenanceFacts(m()).searchRan).toBe(false);
		const gateDeclined = provenanceFacts(m({ searchAttempt: { grounded: false, searched: false } }));
		expect(gateDeclined.searchAttempted).toBe(true);
		expect(gateDeclined.searchRan).toBe(false);
		const ranButUngrounded = provenanceFacts(
			m({ searchAttempt: { grounded: false, searched: true } })
		);
		expect(ranButUngrounded.searchAttempted).toBe(true);
		expect(ranButUngrounded.searchRan).toBe(true);
	});

	it("disposition: classifies a real model answer, but never a layer-decline or cache turn", () => {
		const refusal =
			"I'm sorry, but I cannot assist with that request. For safety reasons, I cannot provide guidance.";
		expect(provenanceFacts(m({ content: refusal })).disposition).toBe("self-declined");
		// a normal answer
		expect(provenanceFacts(m({ content: "Bern is the capital." })).disposition).toBe("answered");
		// a SAFETY-LAYER decline (moderation.flagged) is NOT a model disposition — stays "answered"
		expect(
			provenanceFacts(
				m({
					content: refusal,
					moderation: { flagged: true, label: "x", score: 1, kind: "toxicity" },
				})
			).disposition
		).toBe("answered");
		// a cache-served starter is not a model answer either
		expect(provenanceFacts(m({ content: refusal, servedFromCache: true })).disposition).toBe(
			"answered"
		);
	});
});
