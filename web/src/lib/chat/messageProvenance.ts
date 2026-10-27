import type { AssistRole, AssistedBy, Message } from "$lib/chat/types/Message";
import type { SearchContext } from "$lib/chat/types/Search";
import type { RagContext } from "$lib/chat/types/Rag";
import type {
	MessageRagUpdate,
	MessageWebSearchUpdate,
	MessageWritePolicyUpdate,
	MessageAgentToolsUpdate,
	MessageUnrunCodeUpdate,
	MessageAgentConfirmUpdate,
	MessageAgentConfirmResultUpdate,
	MessageCalculationUpdate,
	MessageMcpCallUpdate,
} from "$lib/chat/types/MessageUpdate";
import type { ModerationKind } from "$lib/chat/types/MessageUpdate";

// SINGLE source of truth for the provenance markers stamped onto an assistant
// message. By construction these markers are written in TWO places: the server
// (authoritative, persisted to the DB) and the client (optimistic, so the
// citations strip / safety decline / map pulse appear LIVE during streaming, not
// only after the post-stream reload re-hydrates from the DB). Those two paths used
// to each inline the same object literal — a classic inline behavioral twin that
// silently drifts as we add provenance fields. They are collapsed here so the
// marker SHAPE has one authority. (One shared builder, rather than policing two copies with a test.)
//
// What stays at the call sites on purpose: the DECISIONS (did a search run? did the
// safety pre-screen flag this, as toxicity or child-safety?). Only the shape of the
// resulting marker is shared — the safety/report seam logic is untouched so its 1:1
// parity with the downstream port is preserved.

// Web-search provenance: the numbered open sources the answer was told to cite.
// `evidence` (the raw grounding block) is deliberately dropped — it feeds the model,
// never persistence. Returns undefined when nothing grounded the turn, so the "only
// stamp when there are sources" contract lives in one place (callers just assign the
// result when truthy). The honest invariant downstream UI relies on: webSearch is
// present IFF sources.length > 0.
export function searchProvenance(
	searchContext: SearchContext | MessageWebSearchUpdate | undefined | null
): NonNullable<Message["webSearch"]> | undefined {
	if (!searchContext?.sources.length) return undefined;
	return {
		query: searchContext.query,
		sources: searchContext.sources,
		asOf: searchContext.asOf,
	};
}

// Search-attempted marker: stamped when the open-web search path was engaged for this turn (the
// margin gate ran, or mode was "always") but the turn never ended up grounded — no `webSearch`
// stamp exists (searchProvenance returned undefined for the same turn). Without this the trace
// silently reads "from training" with no record a search was ever considered, even though the
// live request log showed "Searching the open web…" moments earlier. `attempted` gates whether
// the search path was engaged AT ALL (false for a plain community-sufficient / mode-off turn, in
// which case this always returns undefined regardless of the other args); `searched` distinguishes
// "the gate declined to query the engines" (false) from "a round-trip ran and found nothing
// verified" (true) — two honestly different non-events. The invariant: searchAttempt and webSearch
// are mutually exclusive — stamped only when the path was engaged AND it did not ground the turn.
//
// `failed` says the search ran and did not finish, so the answer can say so. Without it a
// search cut at its deadline stored searched=false, which X-ray read as "decided a search wasn't needed". (CUR-4091)
export function searchAttemptNotice(
	attempted: boolean,
	searched: boolean,
	webStamp: Message["webSearch"] | undefined,
	failed?: NonNullable<Message["searchAttempt"]>["failed"]
): NonNullable<Message["searchAttempt"]> | undefined {
	if (!attempted || webStamp) return undefined;
	return { grounded: false, searched, ...(failed ? { failed } : {}) };
}

// RAG-store provenance: catalog + federated sources the answer was told to cite, plus
// optional vault synthesis (attributed separately). `evidence` is deliberately dropped.
// Returns undefined when nothing grounded the turn. The honest invariant: rag is present
// IFF sources.length > 0 OR vaultSynthesis is non-empty.
export function ragProvenance(
	rag: RagContext | MessageRagUpdate | null | undefined
): NonNullable<Message["rag"]> | undefined {
	if (!rag) return undefined;
	const hasSources = (rag.sources?.length ?? 0) > 0;
	const hasVault = Boolean(rag.vaultSynthesis?.trim());
	if (!hasSources && !hasVault) return undefined;
	return {
		query: rag.query,
		sources: rag.sources ?? [],
		asOf: rag.asOf,
		vaultSynthesis: rag.vaultSynthesis,
	};
}

// Open-component (MCP) provenance: the open HF Space tool that ran for this turn. The honest invariant:
// mcp is present IFF a tool actually ran (we have its name). Returns undefined otherwise so the "only
// stamp when a component ran" contract lives in one place — same shape-authority pattern as search/RAG.
// Accepts either the streamed MessageMcpUpdate or the raw McpToolResult (both carry `tool`).
export function mcpProvenance(
	mcp:
		| {
				tool?: string;
				space?: string;
				audio?: string;
				skipped?: boolean;
				skipMs?: number;
				failed?: boolean;
				unsupportedLanguage?: string;
				fallbackAudio?: string;
				voice?: string;
		  }
		| null
		| undefined
): NonNullable<Message["mcp"]> | undefined {
	// Honesty path: a tool was attempted but the Space was unavailable (skipped). Record it even though
	// there's no tool name — the trace reports "a tool was unavailable" instead of the skip being silent.
	if (mcp?.skipped) {
		return {
			tool: "",
			skipped: true,
			...(mcp.skipMs != null ? { skipMs: mcp.skipMs } : {}),
			...(mcp.failed ? { failed: true } : {}),
			...(mcp.unsupportedLanguage ? { unsupportedLanguage: mcp.unsupportedLanguage } : {}),
			...(mcp.fallbackAudio ? { fallbackAudio: mcp.fallbackAudio } : {}),
		};
	}
	const tool = mcp?.tool?.trim();
	if (!tool) return undefined;
	const out: NonNullable<Message["mcp"]> = { tool };
	const space = mcp?.space?.trim();
	if (space) out.space = space;
	const audio = mcp?.audio?.trim();
	if (audio) out.audio = audio;
	const voice = mcp?.voice?.trim();
	if (audio && voice) out.voice = voice;
	return out;
}

// Write-permission provenance (CUR-471): stamped only when this caller's writes were actually
// restricted for the task ("deny_writes") — a plain "allow" turn, the overwhelming common case, has
// nothing to explain, so returns undefined then. Same shape-authority pattern as mcpProvenance above:
// the DECISION (was this caller resolved to deny_writes?) is made upstream by agent-service; only the
// marker's shape is shared here. `tier`/task counts ride through unchanged — only `staged` populates
// the counts (uniform allow/deny_writes always report tier:"uniform" with null counts).
export function writePolicyProvenance(
	update: MessageWritePolicyUpdate | null | undefined
): NonNullable<Message["writePolicy"]> | undefined {
	if (!update || update.policy !== "deny_writes") return undefined;
	return {
		policy: "deny_writes",
		tier: update.tier,
		tasksDone: update.tasksDone ?? null,
		tasksRequired: update.tasksRequired ?? null,
	};
}

// Agent tool-execution provenance (CUR-601): stamped only when the ACP tool-call stream observed at
// least one real tool run this turn — an empty/missing toolKinds has nothing to explain (same CUR-234
// ambiguity `writePolicyProvenance`'s neighbor discusses), so returns undefined then. Same
// shape-authority pattern as mcpProvenance/writePolicyProvenance above.
export function agentToolsProvenance(
	update: MessageAgentToolsUpdate | null | undefined
): NonNullable<Message["agentTools"]> | undefined {
	if (!update?.toolKinds?.length) return undefined;
	return { toolKinds: update.toolKinds, counts: update.counts };
}

// Unrun-code provenance (CUR-1341): the mirror of agentToolsProvenance above, and the same
// shape-authority pattern — one function owns the stamp so the server's persisted copy and the client's
// optimistic live copy cannot drift. Stamps on any reason, because unlike toolKinds there is no empty
// case to disambiguate: the server emits this update ONLY when its own unrun check fired, so an update
// arriving at all is the signal. A missing/blank reason is a malformed update rather than a quiet
// negative, so it returns undefined instead of inventing a default that would make the panel claim
// something the server never said.
export function unrunCodeProvenance(
	update: MessageUnrunCodeUpdate | null | undefined
): NonNullable<Message["unrunCode"]> | undefined {
	if (!update?.reason) return undefined;
	return { reason: update.reason };
}

// One answer can make several calculate calls, so this accumulates, in call order. Server
// and client fold updates through this one function so the persisted and live lists cannot drift.
// Capped: the tool loop stops after three rounds, but a round can carry any number of calls, and a
// runaway should not grow the message without bound. (CUR-2273)
const MAX_CALCULATIONS = 12;
// The kit caps a turn at four calls; the bound here only stops a malformed stream growing
// the message. (CUR-3026)
const MAX_MCP_CALLS = 8;
export function mcpCallAppended(
	list: Message["mcpCalls"],
	update: MessageMcpCallUpdate
): NonNullable<Message["mcpCalls"]> {
	const current = list ?? [];
	if (current.length >= MAX_MCP_CALLS) return current;
	return [
		...current,
		{
			server: update.server,
			tool: update.tool,
			outcome: update.outcome,
			ms: update.ms,
			...(update.input !== undefined ? { input: update.input } : {}),
			...(update.output !== undefined ? { output: update.output } : {}),
		},
	];
}

export function calculationAppended(
	list: Message["calculations"],
	update: MessageCalculationUpdate
): NonNullable<Message["calculations"]> {
	const current = list ?? [];
	if (current.length >= MAX_CALCULATIONS) return current;
	return [
		...current,
		{
			expression: update.expression,
			...(update.result !== undefined ? { result: update.result } : {}),
			...(update.error !== undefined ? { error: update.error } : {}),
			...(update.counts !== undefined ? { counts: update.counts } : {}),
		},
	];
}

// Agent confirmation gate (CUR-218): unlike the stamp-once shapes above, one turn can open more than
// one confirmation, so this ACCUMULATES rather than replaces — server and client both fold updates
// through the same two functions so the array can never drift between the persisted and live view.
//
// Opens a new entry. Deduped by confirmId: agent-service's own SSE delivery can redeliver a frame (the
// heartbeat/reconnect path in endpointAgent.ts reads the same buffer), and a second identical "awaiting"
// frame for a call already open must not spawn a second Allow/Deny prompt for the same decision.
export function agentConfirmOpened(
	existing: NonNullable<Message["agentConfirmations"]> | undefined,
	update: MessageAgentConfirmUpdate
): NonNullable<Message["agentConfirmations"]> {
	const list = existing ?? [];
	if (list.some((c) => c.confirmId === update.confirmId)) return list;
	return [
		...list,
		{
			taskId: update.taskId,
			confirmId: update.confirmId,
			kind: update.kind,
			title: update.title,
			summary: update.summary,
			...(update.plain ? { plain: update.plain } : {}),
			...(update.deadlineAt !== undefined ? { deadlineAt: update.deadlineAt } : {}),
			...(update.channel ? { channel: update.channel } : {}),
		},
	];
}

// Resolves an open entry in place (decision + reason). A resolution for a confirmId this message never
// saw open (a frame missed, or arriving out of order) is a no-op — there is nothing to attach it to, and
// inventing an entry from the resolution alone would show a decision with no question ever shown.
export function agentConfirmResolved(
	existing: NonNullable<Message["agentConfirmations"]> | undefined,
	update: MessageAgentConfirmResultUpdate
): NonNullable<Message["agentConfirmations"]> | undefined {
	if (!existing) return existing;
	return existing.map((c) =>
		c.confirmId === update.confirmId
			? { ...c, decision: update.decision, reason: update.reason }
			: c
	);
}

// Read-side provenance gate for the starter-cache fallback. A turn served from the
// pre-vetted starter cache (message.servedFromCache — set only when the time-to-first-token
// watchdog gave up because the live request never reached the server) did NOT run the live
// pipeline. So the inline provenance trace, which would otherwise assert "Apertus generated
// this" / "grounded on N sources" / "verified by a second model", MUST be suppressed and
// replaced by the honest CacheNotice. These two predicates are mutually exclusive by
// construction for any assistant message, so the UI can never simultaneously claim BOTH
// "served from a saved answer" AND "freshly generated live" — the core honesty invariant.
// Both false for user/system turns (neither surface belongs on them).
export function showsLiveProvenanceTrace(
	message: Pick<Message, "from" | "servedFromCache">
): boolean {
	return message.from === "assistant" && !message.servedFromCache;
}

export function showsCacheNotice(message: Pick<Message, "from" | "servedFromCache">): boolean {
	return message.from === "assistant" && Boolean(message.servedFromCache);
}

// Safety-decline marker: stamped when the pre-screen declined a turn before the
// model ran. The decision (Coop child-safety / content vs in-app prompt-injection) is made
// upstream and differs per call site — the server computes it; the client reads it off the emitted
// Safety update — so this factory takes the already-decided fields. `flagged` is
// hardcoded true: a moderation marker only ever exists on a decline, and pinning it
// here removes a drift vector (no call site can stamp a marker with flagged:false).
export function moderationMarker(fields: {
	label: string | null;
	score: number;
	kind: ModerationKind;
	// Curated public-safe rule label, resolved server-side. Stamped only when present, so an unlabeled
	// rule (or a non-Coop decline like prompt-injection) leaves `ruleLabel` absent rather than null —
	// the display surfaces then fall back to the generic safety copy.
	ruleLabel?: string | null;
	// The screen could not run (fail-closed UNKNOWN), so nothing was flagged (CUR-2301).
	unscreened?: boolean;
	// A self-harm rule declined the turn, so the Support resources card shows with it (CUR-2111).
	support?: boolean;
}): NonNullable<Message["moderation"]> {
	return {
		flagged: true,
		label: fields.label,
		score: fields.score,
		kind: fields.kind,
		...(fields.ruleLabel ? { ruleLabel: fields.ruleLabel } : {}),
		...(fields.unscreened ? { unscreened: true } : {}),
		...(fields.support ? { support: true } : {}),
	};
}

// One helper model's entry, for a model that worked on the turn without writing it. `baseURL`
// is the address the call went to, or a bare host (LiteLLM's api-base header can be either), and only
// its host is kept, so a path or a key in a query string never reaches the message. Returns undefined without a model id: an entry naming nobody would be a row in
// the trace with nothing behind it. (CUR-984)
export function assistedByEntry(
	role: AssistRole,
	model: string | undefined,
	baseURL?: string,
	provider?: string
): AssistedBy | undefined {
	const id = model?.trim();
	if (!id) return undefined;
	let backend: string | undefined;
	try {
		backend = baseURL ? new URL(baseURL.includes("://") ? baseURL : `https://${baseURL}`).host : undefined;
	} catch {
		backend = undefined;
	}
	return {
		role,
		model: id,
		...(provider?.trim() ? { provider: provider.trim() } : {}),
		...(backend ? { backend } : {}),
	};
}

// Server and client merge helper entries through this one function. One entry per role, a later entry
// for a role replacing the earlier one, first-seen order kept; undefined when there is nothing to keep.
export function assistedByMerged(
	existing: readonly AssistedBy[] | undefined,
	incoming: readonly AssistedBy[] | undefined
): AssistedBy[] | undefined {
	const out = [...(existing ?? [])];
	for (const entry of incoming ?? []) {
		const at = out.findIndex((e) => e.role === entry.role);
		if (at >= 0) out[at] = entry;
		else out.push(entry);
	}
	return out.length ? out : undefined;
}
