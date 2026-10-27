import { describe, it, expect } from "vitest";
import {
	searchProvenance,
	searchAttemptNotice,
	ragProvenance,
	mcpProvenance,
	writePolicyProvenance,
	agentToolsProvenance,
	unrunCodeProvenance,
	agentConfirmOpened,
	agentConfirmResolved,
	moderationMarker,
	showsLiveProvenanceTrace,
	showsCacheNotice,
	assistedByEntry,
} from "./messageProvenance";
import type { SearchContext } from "$lib/chat/types/Search";
import type { RagContext } from "$lib/chat/types/Rag";
import type { Message } from "$lib/chat/types/Message";

// These helpers are the SINGLE authority for the provenance markers that the server
// (+server.ts, persisted) and the client (+page.svelte, optimistic during streaming)
// both stamp onto an assistant message. The bug class this guards: those two paths
// inlining the same object literal could silently drift, so a fresh
// streamed answer and the same answer after reload would carry different provenance.
// Collapsing to these functions makes drift impossible; this spec pins their contract.

const sources: SearchContext["sources"] = [
	{ n: 1, title: "EU AI Act", url: "https://example.org/a", snippet: "…", engine: "Wikipedia" },
	{ n: 2, title: "Open web", url: "https://example.org/b", snippet: "…", engine: "Firecrawl" },
];

describe("searchProvenance", () => {
	it("stamps query/sources/asOf when the turn was grounded", () => {
		const ctx: SearchContext = {
			query: "eu ai act status",
			sources,
			asOf: "2026-06-19T00:00:00.000Z",
			evidence: "[1] … [2] …",
		};
		expect(searchProvenance(ctx)).toEqual({
			query: "eu ai act status",
			sources,
			asOf: "2026-06-19T00:00:00.000Z",
		});
	});

	it("drops evidence — it feeds the model, is never persisted", () => {
		const ctx: SearchContext = {
			query: "q",
			sources,
			asOf: "2026-06-19T00:00:00.000Z",
			evidence: "SECRET grounding block",
		};
		expect(searchProvenance(ctx)).not.toHaveProperty("evidence");
	});

	it("returns undefined when nothing grounded the turn (no context, or zero sources)", () => {
		// The honest invariant the UI relies on: webSearch is present IFF sources.length > 0.
		// A search that ran but found nothing must NOT produce a webSearch marker — that turn
		// is model-knowledge, and the SourceClass chip says so.
		expect(searchProvenance(undefined)).toBeUndefined();
		expect(searchProvenance(null)).toBeUndefined();
		expect(
			searchProvenance({ query: "q", sources: [], asOf: "2026-06-19T00:00:00.000Z", evidence: "" })
		).toBeUndefined();
	});
});

describe("searchAttemptNotice", () => {
	const webStamp = { query: "q", sources, asOf: "2026-06-19T00:00:00.000Z" };

	it("stamps searched:true when a round-trip ran but did not ground the turn", () => {
		expect(searchAttemptNotice(true, true, undefined)).toEqual({ grounded: false, searched: true });
	});

	it("stamps searched:false when the margin gate declined to query the engines at all", () => {
		expect(searchAttemptNotice(true, false, undefined)).toEqual({
			grounded: false,
			searched: false,
		});
	});

	it("returns undefined when the search path was never engaged at all", () => {
		expect(searchAttemptNotice(false, false, undefined)).toBeUndefined();
		expect(searchAttemptNotice(false, true, undefined)).toBeUndefined();
	});

	it("returns undefined when the search DID ground the turn (mutually exclusive with webSearch)", () => {
		expect(searchAttemptNotice(true, true, webStamp)).toBeUndefined();
	});
});

describe("ragProvenance", () => {
	const ragSources: RagContext["sources"] = [
		{ n: 1, title: "Cloud Compute", snippet: "GPU.", engine: "Potluck" },
	];

	it("stamps query/sources/asOf when catalog retrieval grounded the turn", () => {
		const ctx: RagContext = {
			query: "cloud compute oss",
			sources: ragSources,
			asOf: "2026-06-19T00:00:00.000Z",
			evidence: "[1] Cloud Compute (Potluck)",
		};
		expect(ragProvenance(ctx)).toEqual({
			query: "cloud compute oss",
			sources: ragSources,
			asOf: "2026-06-19T00:00:00.000Z",
			vaultSynthesis: undefined,
		});
	});

	it("stamps vault synthesis without numbered sources", () => {
		const ctx: RagContext = {
			query: "personality in Vaud",
			sources: [],
			asOf: "2026-06-19T00:00:00.000Z",
			evidence: "",
			vaultSynthesis: "Charlie Chaplin lived in Vevey.",
		};
		expect(ragProvenance(ctx)).toEqual({
			query: "personality in Vaud",
			sources: [],
			asOf: "2026-06-19T00:00:00.000Z",
			vaultSynthesis: "Charlie Chaplin lived in Vevey.",
		});
	});

	it("drops evidence — it feeds the model, is never persisted", () => {
		const ctx: RagContext = {
			query: "q",
			sources: ragSources,
			asOf: "2026-06-19T00:00:00.000Z",
			evidence: "SECRET grounding block",
		};
		expect(ragProvenance(ctx)).not.toHaveProperty("evidence");
	});

	it("returns undefined when nothing grounded the turn", () => {
		expect(ragProvenance(undefined)).toBeUndefined();
		expect(ragProvenance(null)).toBeUndefined();
		expect(
			ragProvenance({
				query: "q",
				sources: [],
				asOf: "2026-06-19T00:00:00.000Z",
				evidence: "",
			})
		).toBeUndefined();
	});
});

describe("mcpProvenance", () => {
	it("stamps the tool name when an open component ran", () => {
		expect(mcpProvenance({ tool: "ResembleAI_Chatterbox_generate_tts_audio" })).toEqual({
			tool: "ResembleAI_Chatterbox_generate_tts_audio",
		});
	});

	it("accepts the streamed MessageMcpUpdate shape (carries `tool`)", () => {
		// The same factory the client applies to a live MessageUpdateType.Mcp event.
		expect(mcpProvenance({ tool: "flux_generate_image" })?.tool).toBe("flux_generate_image");
	});

	it("keeps `failed` on a skip, so a tool's error is never relabelled a cold start (CUR-2645)", () => {
		expect(mcpProvenance({ tool: "", skipped: true, skipMs: 12, failed: true })).toEqual({
			tool: "",
			skipped: true,
			skipMs: 12,
			failed: true,
		});
		expect(mcpProvenance({ tool: "", skipped: true, skipMs: 12 })).not.toHaveProperty("failed");
	});

	it("passes through the Space origin and audio URL when present", () => {
		expect(
			mcpProvenance({ tool: "tts", space: "https://x.hf.space", audio: "https://x.hf.space/a.wav" })
		).toEqual({ tool: "tts", space: "https://x.hf.space", audio: "https://x.hf.space/a.wav" });
		// omits empty/blank optional fields
		expect(mcpProvenance({ tool: "tts", space: "  ", audio: "" })).toEqual({ tool: "tts" });
	});

	it("returns undefined when no tool ran (honest invariant: mcp present IFF a component ran)", () => {
		expect(mcpProvenance(null)).toBeUndefined();
		expect(mcpProvenance(undefined)).toBeUndefined();
		expect(mcpProvenance({})).toBeUndefined();
		expect(mcpProvenance({ tool: "" })).toBeUndefined();
		expect(mcpProvenance({ tool: "   " })).toBeUndefined();
	});
});

describe("writePolicyProvenance", () => {
	it("stamps a staged/new-tier caller's task counts", () => {
		expect(
			writePolicyProvenance({
				type: "writePolicy" as never,
				policy: "deny_writes",
				tier: "new",
				tasksDone: 1,
				tasksRequired: 3,
			})
		).toEqual({ policy: "deny_writes", tier: "new", tasksDone: 1, tasksRequired: 3 });
	});

	it("stamps a uniform (non-staged) deny_writes caller with null counts", () => {
		expect(
			writePolicyProvenance({
				type: "writePolicy" as never,
				policy: "deny_writes",
				tier: "uniform",
				tasksDone: null,
				tasksRequired: null,
			})
		).toEqual({ policy: "deny_writes", tier: "uniform", tasksDone: null, tasksRequired: null });
	});

	it("returns undefined for policy:allow (honest invariant: nothing to explain when writes work)", () => {
		expect(
			writePolicyProvenance({
				type: "writePolicy" as never,
				policy: "allow",
				tier: "uniform",
				tasksDone: null,
				tasksRequired: null,
			})
		).toBeUndefined();
	});

	it("returns undefined for null/undefined", () => {
		expect(writePolicyProvenance(null)).toBeUndefined();
		expect(writePolicyProvenance(undefined)).toBeUndefined();
	});
});

describe("agentToolsProvenance", () => {
	it("stamps the tool kinds when the agent ran real ACP tools", () => {
		expect(agentToolsProvenance({ type: "agentTools" as never, toolKinds: ["write_file", "terminal"] })).toEqual({
			toolKinds: ["write_file", "terminal"],
		});
	});

	it("returns undefined for an empty or missing toolKinds (honest invariant: nothing to explain when no tool ran)", () => {
		expect(agentToolsProvenance({ type: "agentTools" as never, toolKinds: [] })).toBeUndefined();
		expect(agentToolsProvenance(null)).toBeUndefined();
		expect(agentToolsProvenance(undefined)).toBeUndefined();
	});

	it("forwards counts when present, same gate as toolKinds (CUR-775)", () => {
		expect(
			agentToolsProvenance({
				type: "agentTools" as never,
				toolKinds: ["write_file", "terminal"],
				counts: { write_file: 1, terminal: 2 },
			})
		).toEqual({
			toolKinds: ["write_file", "terminal"],
			counts: { write_file: 1, terminal: 2 },
		});
	});
});

describe("agentConfirmOpened", () => {
	const open = (confirmId: string) => ({
		type: "agentConfirm" as never,
		taskId: "task-1",
		confirmId,
		kind: "edit",
		title: "write_file: notes.txt",
		summary: "notes.txt: hello",
	});

	it("appends a new entry to an empty/missing list", () => {
		expect(agentConfirmOpened(undefined, open("c1"))).toEqual([
			{ taskId: "task-1", confirmId: "c1", kind: "edit", title: "write_file: notes.txt", summary: "notes.txt: hello" },
		]);
	});

	it("appends alongside an existing entry (a turn can pause more than once)", () => {
		const existing = agentConfirmOpened(undefined, open("c1"));
		const result = agentConfirmOpened(existing, open("c2"));
		expect(result.map((c) => c.confirmId)).toEqual(["c1", "c2"]);
	});

	it("dedupes a redelivered open frame for the same confirmId (no second prompt for one decision)", () => {
		const existing = agentConfirmOpened(undefined, open("c1"));
		const result = agentConfirmOpened(existing, open("c1"));
		expect(result).toEqual(existing);
		expect(result).toHaveLength(1);
	});

	it("CUR-1094: carries deadlineAt through when the update has one", () => {
		const withDeadline = { ...open("c1"), deadlineAt: 1_000_000 };
		expect(agentConfirmOpened(undefined, withDeadline)[0].deadlineAt).toBe(1_000_000);
	});

	it("CUR-1094: omits deadlineAt (not undefined-valued) on an older/coarse frame that carries none", () => {
		const entry = agentConfirmOpened(undefined, open("c1"))[0];
		expect("deadlineAt" in entry).toBe(false);
	});
});

describe("agentConfirmResolved", () => {
	const opened = () =>
		agentConfirmOpened(undefined, {
			type: "agentConfirm" as never,
			taskId: "task-1",
			confirmId: "c1",
			kind: "edit",
			title: "write_file: notes.txt",
			summary: "notes.txt: hello",
		});

	it("fills in decision/reason on the matching open entry", () => {
		const result = agentConfirmResolved(opened(), {
			type: "agentConfirmResult" as never,
			confirmId: "c1",
			decision: "allow",
			reason: "human",
		});
		expect(result?.[0]).toMatchObject({ confirmId: "c1", decision: "allow", reason: "human" });
	});

	it("marks a timed-out confirmation denied with reason timeout (agent-service's own fail-closed default)", () => {
		const result = agentConfirmResolved(opened(), {
			type: "agentConfirmResult" as never,
			confirmId: "c1",
			decision: "deny",
			reason: "timeout",
		});
		expect(result?.[0]).toMatchObject({ decision: "deny", reason: "timeout" });
	});

	it("is a no-op for a confirmId the message never saw open — nothing to attach the resolution to", () => {
		const existing = opened();
		const result = agentConfirmResolved(existing, {
			type: "agentConfirmResult" as never,
			confirmId: "never-opened",
			decision: "allow",
			reason: "human",
		});
		expect(result).toEqual(existing);
	});

	it("is a no-op when the list itself was never opened", () => {
		expect(
			agentConfirmResolved(undefined, {
				type: "agentConfirmResult" as never,
				confirmId: "c1",
				decision: "allow",
				reason: "human",
			})
		).toBeUndefined();
	});
});

describe("moderationMarker", () => {
	it("always sets flagged:true (a marker only exists on a decline)", () => {
		const m = moderationMarker({ label: "toxic", score: 0.97, kind: "toxicity" });
		expect(m.flagged).toBe(true);
	});

	it("carries label/score/kind through unchanged (toxicity)", () => {
		expect(moderationMarker({ label: "toxic", score: 0.97, kind: "toxicity" })).toEqual({
			flagged: true,
			label: "toxic",
			score: 0.97,
			kind: "toxicity",
		});
	});

	it("carries the child-safety kind through (server's isChild branch)", () => {
		expect(moderationMarker({ label: "child_safety", score: 1, kind: "child_safety" })).toEqual({
			flagged: true,
			label: "child_safety",
			score: 1,
			kind: "child_safety",
		});
	});

	it("preserves a null label", () => {
		expect(moderationMarker({ label: null, score: 0.8, kind: "toxicity" }).label).toBeNull();
	});

	it("stamps support only on a self-harm decline, and leaves it absent otherwise (CUR-2111)", () => {
		const marker = (support?: boolean) =>
			moderationMarker({ label: "content_policy", score: 1, kind: "content_policy", support });
		expect(marker(true).support).toBe(true);
		expect(marker()).not.toHaveProperty("support");
		expect(marker(false)).not.toHaveProperty("support");
	});
});

describe("cache-fallback provenance gate", () => {
	const msg = (over: Partial<Message>): Pick<Message, "from" | "servedFromCache"> => ({
		from: "assistant",
		servedFromCache: undefined,
		...over,
	});

	it("shows the live trace (not the cache notice) for a normal assistant answer", () => {
		const m = msg({});
		expect(showsLiveProvenanceTrace(m)).toBe(true);
		expect(showsCacheNotice(m)).toBe(false);
	});

	it("shows the cache notice (not the live trace) when served from cache", () => {
		const m = msg({ servedFromCache: true });
		expect(showsCacheNotice(m)).toBe(true);
		expect(showsLiveProvenanceTrace(m)).toBe(false);
	});

	it("is mutually exclusive for every assistant message — never claims both at once", () => {
		// The core honesty invariant: a turn can never read as BOTH "served from a saved
		// answer" AND "freshly generated live". Exactly one surface shows on an assistant turn.
		for (const servedFromCache of [undefined, false, true]) {
			const m = msg({ servedFromCache });
			expect(showsLiveProvenanceTrace(m)).not.toBe(showsCacheNotice(m));
		}
	});

	it("shows neither on user or system turns", () => {
		for (const from of ["user", "system"] as const) {
			expect(showsLiveProvenanceTrace(msg({ from }))).toBe(false);
			expect(showsCacheNotice(msg({ from, servedFromCache: true }))).toBe(false);
		}
	});
});

describe("unrunCodeProvenance", () => {
	it("stamps the reason, so the panel header can tell an overclaim from a run that did not finish", () => {
		expect(
			unrunCodeProvenance({ type: "unrunCode" as never, reason: "wrote-not-run" })
		).toEqual({ reason: "wrote-not-run" });
		expect(
			unrunCodeProvenance({ type: "unrunCode" as never, reason: "service-verdict-structural" })
		).toEqual({ reason: "service-verdict-structural" });
	});

	it("returns undefined on a malformed update rather than inventing a default reason", () => {
		// Unlike agentToolsProvenance above there is no empty case to filter — the server emits this only
		// when its own unrun check fired, so the update ARRIVING is the signal. A blank reason is a
		// malformed update, and defaulting it would make the header assert something the server never
		// said, which is the exact failure CUR-1341 is about.
		expect(unrunCodeProvenance({ type: "unrunCode" as never, reason: "" as never })).toBeUndefined();
		expect(unrunCodeProvenance(null)).toBeUndefined();
		expect(unrunCodeProvenance(undefined)).toBeUndefined();
	});
});

describe("assistedByEntry — a helper model's row keeps the host and nothing else of the address (CUR-984)", () => {
	it("keeps only the host of a full base URL, so a path or query never reaches the message", () => {
		expect(
			assistedByEntry("math-route", "mistral-small-2603", "https://api.mistral.ai/v1?key=x", "")
		).toEqual({ role: "math-route", model: "mistral-small-2603", backend: "api.mistral.ai" });
	});

	it("accepts a bare host, the shape LiteLLM's api-base header can take", () => {
		expect(assistedByEntry("search-decision", "m", "api.example.org")?.backend).toBe("api.example.org");
	});

	it("keeps the HF router's provider when the call went through the router", () => {
		expect(
			assistedByEntry("math-route", "zai-org/GLM-5.2", "https://router.huggingface.co/v1", "scaleway")
		).toMatchObject({ provider: "scaleway", backend: "router.huggingface.co" });
	});

	it("returns nothing without a model id, rather than a row naming nobody", () => {
		expect(assistedByEntry("math-route", "  ", "https://api.mistral.ai/v1")).toBeUndefined();
	});

	it("drops an address that does not parse instead of storing it whole", () => {
		expect(assistedByEntry("math-route", "m", "not a url")).toEqual({ role: "math-route", model: "m" });
	});
});
