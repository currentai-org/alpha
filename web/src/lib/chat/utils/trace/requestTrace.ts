// Honest request-trace data layer — the ordered, plain-English sequence of what actually ran for a
// turn, for the "behind the scenes" sequential view (the request-log view). This is the DATA the view
// binds to; the rendering is the frontend's.
//
// HONESTY CONTRACT (this is the whole point — the product fights false precision). The rules:
//   - ORDER matches the real server pipeline (src/routes/conversation/[id]/+server.ts): the safety
//     pre-screen runs FIRST, a declined turn returns BEFORE any retrieval or model run, RAG is
//     server-side, guards/persist are post-generation. A fabricated ORDER is the same false-precision
//     sin as a fabricated timing.
//   - We never assert a step COMPLETED without evidence: inference only when there is answer content,
//     persist only on a non-cache turn, and the safety step never prints "passed" (toxic-bert fails
//     OPEN — an un-flagged turn is not proof it was screened; see provenanceFacts ScreenState).
//   - A cache-served turn (the request never reached the server) gets an honest short trace, not a
//     fabricated full pipeline.
//   - `response` is filled ONLY from data we genuinely recorded. `status` marks failed-open / interrupted
//     steps so the view can render them honestly. `timingMs` is REAL or null — never fabricated; we
//     measure no per-step latency yet, so it is null everywhere (a test asserts this).
//   - We do NOT invent a discrete "routing decision" component (no per-turn router runs on this path),
//     and we do not claim per-turn work we can't evidence (reranking, recency-hedge corrections).
//
// `node` links a step to its stack-map node id (reveal.ts) for "click for the project behind this step";
// it is set only where a real component ran, never to a node that didn't.

import type { GroundcheckOutcome, Message } from "$lib/chat/types/Message";
import type { RagEngine } from "$lib/chat/types/Rag";
import { resolveModelIdentity } from "$lib/chat/identity";
import {
	WEBSEARCH_NODE,
	SAFETY_NODES,
	VAULT_NODE,
	modelNodeFor,
} from "$lib/chat/components/stack/reveal";
import { provenanceFacts } from "./provenanceFacts";
import { summarizeToolRun } from "./toolRunSummary";
import { DISPOSITION_COPY } from "$lib/chat/utils/responseDisposition";
import { productAttributionForNode } from "$lib/chat/components/stack/provenanceProductLine";
import { removedClaimsPhrase } from "$lib/chat/components/stack/stepEvidence";

export type TraceLayer = "interface" | "app" | "data" | "retrieval" | "safety" | "model" | "verify";

/** ok = evidenced/complete · failed-open = a safety screen could not run · interrupted = generation was cut. */
export type TraceStatus = "ok" | "failed-open" | "interrupted";

export interface TraceStep {
	/** stable key for rendering */
	id: string;
	/** which stack layer this belongs to */
	layer: TraceLayer;
	/** stack-map node id (links to the project behind the step); null = app-internal, no clickable project */
	node: string | null;
	/** the specific RAG engine this step retrieved from — set only on `rag-*` steps, so a consumer
	 *  can filter message.rag.sources down to exactly the sources THIS step's count refers to,
	 *  instead of a caller accidentally showing every engine's sources under one step. */
	engine?: RagEngine;
	/** component / step name */
	title: string;
	/** plain-English: what it was called to do */
	detail: string;
	/** REAL response summary, present only where the turn actually recorded one */
	response?: string;
	/** honesty marker for non-clean outcomes */
	status: TraceStatus;
	/** real per-step latency in ms, or null when we did not measure it (never fabricated) */
	timingMs: number | null;
	/** roadmap open source attribution when this step maps to a provenance product */
	productAttribution?: string;
}

type Step = Omit<TraceStep, "status" | "timingMs"> & {
	status?: TraceStatus;
	timingMs?: number | null;
};

/**
 * Build the ordered, honest step list for an assistant turn. Pure: derived entirely from the message's
 * recorded provenance + the known pipeline order, with no fabricated data, evidence, or timing.
 */
export function deriveRequestTrace(message: Message, modelId?: string): TraceStep[] {
	const f = provenanceFacts(message);
	const steps: TraceStep[] = [];
	const push = (s: Step) => {
		const step: TraceStep = { status: "ok", timingMs: null, ...s };
		if (step.node) {
			const productAttribution = productAttributionForNode(step.node);
			if (productAttribution) step.productAttribution = productAttribution;
		}
		steps.push(step);
	};

	push({
		id: "received",
		layer: "interface",
		node: null,
		title: "Chat UI",
		detail: "Sent your question and authenticated the request.",
	});

	// ── cache-served: the request never reached the server. Don't fabricate a pipeline. ──────────────
	if (f.servedFromCache) {
		push({
			id: "cache",
			layer: "app",
			node: null,
			title: "Connection fallback",
			detail:
				"The live request didn't reach the server, so a pre-vetted starter answer was shown. The model did not run for this turn.",
		});
		return steps;
	}

	push({
		id: "history",
		layer: "data",
		node: null,
		title: "Conversation store · Postgres",
		detail: "Pulled the earlier turns in this conversation for context.",
	});

	// ── safety pre-screen — runs FIRST, before retrieval or the model (toxic-bert fails OPEN) ────────
	const safety: Step = {
		id: "safety",
		layer: "safety",
		node: SAFETY_NODES[0],
		title: "Safety pre-screen",
		detail: "Screened your message before anything else ran.",
	};
	if (f.screen === "flagged") {
		// Only the CURATED rule label is surfaced — never the raw Coop action code that `label` may hold
		// (for a content block it's the opaque action name). Unknown/unlabeled rule → no parenthetical.
		safety.response = `flagged${message.moderation?.ruleLabel ? ` (${message.moderation.ruleLabel})` : ""} — answer withheld`;
	} else if (f.screen === "failed-open") {
		safety.response = "screening unavailable this turn — passed through (failed open)";
		safety.status = "failed-open";
	} else if (f.screen === "clear") {
		safety.response = "screened, no flag raised";
	} else {
		// `unknown`: we did not record a positive screen verdict, so we claim only what's true — that no
		// flag was raised — never that the classifier ran and cleared it.
		safety.response = "no flag raised";
	}
	push(safety);

	// ── declined: the model never ran; stop here (matches the server returning the decline early). ──
	if (f.declined) {
		push({
			id: "declined",
			layer: "safety",
			node: null,
			title: "Declined",
			detail: "The model did not run; a plain decline was returned instead of an answer.",
		});
		return steps;
	}

	// Sources can be attached client-side BEFORE the model runs (RAG/web search resolve ahead of
	// generation), so a turn the model then self-declined / disclaimed / asked to clarify on can still
	// carry a populated rag/webSearch field — same failure shape as the moderation-declined case above
	// (ProvenanceTrace.svelte's `retrieved` derivation), just one layer later: the safety screen passed,
	// the model ran, but it didn't produce a grounded answer, so the retrieved sources were never actually
	// used. Surfacing them (e.g. an OTC-dose self-decline still listing a Wikipedia + an unrelated drug
	// article) falsely implies the answer drew on them. Gate both retrieval steps on a real answer.
	const sourcesWereUsed = f.disposition === "answered";

	// ── community retrieval FIRST (community-first) — RAG runs server-side, before the open web; one
	//    step per store actually hit. Numbered [1..k] ahead of any web sources. ──────────────────────
	for (const hit of sourcesWereUsed ? f.ragHits : []) {
		// Name the actual sources (not just "N sources") — an unidentified "1 source" reads as sketchy.
		// Titles come straight off the persisted message (same data the expandable source list shows),
		// shown like the web step's engine list; cap at two + "+N more" so the receipt stays compact.
		const titles = (message.rag?.sources ?? [])
			.filter((s) => s.engine === hit.engine)
			.map((s) => s.title)
			.filter(Boolean);
		// De-dupe by TITLE before naming: several chunks of the same document commonly rank in the
		// same top-K (e.g. an admin-uploaded page split into multiple pieces), and naively slicing the
		// raw title list would read as a formatting bug — "Doc A, Doc A, +2 more" (a 4-chunk
		// community-docs hit). Name up to two DISTINCT
		// titles, then count "+more" as sources not covered by either named title, so the number stays
		// honest (a title covering 2 of the 4 chunks correctly shrinks the remainder to 1, not 2).
		const uniqueTitles = [...new Set(titles)];
		const shownTitles = uniqueTitles.slice(0, 2);
		const coveredCount = titles.filter((t) => shownTitles.includes(t)).length;
		const remainingCount = titles.length - coveredCount;
		const named = shownTitles.length
			? ` · ${shownTitles.join(", ")}${remainingCount > 0 ? `, +${remainingCount} more` : ""}`
			: "";
		push({
			id: `rag-${hit.node}-${hit.engine}`,
			layer: "retrieval",
			node: hit.node,
			engine: hit.engine,
			title: `Retrieval · ${hit.label}`,
			detail: hit.detail,
			response: `${hit.count} source${hit.count === 1 ? "" : "s"}${named}`,
		});
	}
	if (sourcesWereUsed && f.vault) {
		push({
			id: "rag-vault",
			layer: "retrieval",
			node: VAULT_NODE,
			title: "Federated synthesis · privacy vault",
			detail: "A federated store returned a privacy-filtered synthesis (not a citable document).",
			response: "synthesis returned",
		});
	}

	// ── open-web search — runs server-side AFTER community retrieval (community-first: the web is a
	//    fallback, used when community sources don't cover the question). Numbered after community. ──
	if (sourcesWereUsed && f.webCount > 0) {
		push({
			id: "websearch",
			layer: "retrieval",
			node: WEBSEARCH_NODE,
			title: "Open web search",
			detail:
				"Searched the open web to fill in what community sources didn't cover, and grounded the answer on what it found.",
			response: `${f.webCount} source${f.webCount === 1 ? "" : "s"} · ${f.webEngines.join(", ")}`,
		});
	} else if (sourcesWereUsed && f.searchAttempted) {
		// Honesty: the search path was engaged (the live log showed "Searching the open web…") but
		// the turn never grounded — without this step the attempt vanishes and the turn reads
		// identically to "no search considered at all". `node: null` either way — no project actually
		// contributed to the answer here. Two sub-cases get distinct, equally honest copy: don't claim
		// a round-trip happened when the margin gate just decided one wasn't worth it.
		push({
			id: "websearch-ungrounded",
			layer: "retrieval",
			node: null,
			title: "Open web search",
			detail: f.searchRan
				? "Searched the open web, but no result cleared the relevance bar — answered from training instead of citing a source."
				: "Weighed searching the open web for this, but decided it wasn't necessary — answered from training.",
			response: f.searchRan ? "no source used" : "search skipped",
		});
	}

	// ── failover — CUR-2239: the primary was tried (or skipped) and a backup model answered ────────────
	// Kept as its own step so the receipt names both models; the inference step below names only the one
	// that served.
	if (message.failover) {
		const from = resolveModelIdentity(message.failover.from).short;
		const to = resolveModelIdentity(message.failover.to).short;
		const skipped = message.failover.reason === "skipped";
		push({
			id: "failover",
			layer: "model",
			node: modelNodeFor(message.failover.from),
			title: `${from} · ${skipped ? "skipped" : "didn't answer"}`,
			detail: skipped
				? `A preview test fault took ${from} out before it was tried, so the backup lane, ${to}, answered instead.`
				: `${from} produced no output within its retry budget, so the backup lane, ${to}, answered instead. Nothing ${from} generated reached this answer.`,
			response: `switched to ${to}`,
		});
	}

	// ── inference — only asserted when there is answer content ───────────────────────────────────────
	if (f.answered) {
		const servedId = message.routerMetadata?.model || modelId;
		const identity = resolveModelIdentity(servedId);
		const provider = message.routerMetadata?.provider;
		push({
			id: "inference",
			layer: "model",
			// The node follows what actually served, not a fixed apertus node: a fallback
			// lane's answer lights that model's node on the map.
			node: modelNodeFor(servedId),
			title: `Inference · ${identity.short}`,
			detail: f.interrupted
				? "Read the assembled prompt and started streaming, but the generation was interrupted."
				: f.withheld
					? message.outputModeration?.truncated
						? "Read the assembled prompt and streamed the answer, but output screening flagged a later part — the rest was withheld."
						: "Read the assembled prompt and generated an answer, but output screening flagged it before any of it was shown."
					: f.outputScreen !== "unknown"
						? "Read the assembled prompt and streamed the answer back, screened sentence by sentence before each part was shown."
						: "Read the assembled prompt and streamed the answer back token by token.",
			response: provider ? `${identity.short} · via ${provider}` : identity.short,
			status: f.interrupted ? "interrupted" : "ok",
			// real cumulative time-to-first-word (request-start → first token), where we measured it
			timingMs: message.timings?.ttftMs ?? null,
		});

		// honest disposition of what the model produced — only when it ISN'T a clean answer (it declined
		// itself / stated a limit about itself / asked for clarification). Same signal + copy as the chip.
		if (f.disposition !== "answered") {
			push({
				id: "disposition",
				layer: "model",
				node: null,
				title: "What the model did",
				detail: DISPOSITION_COPY[f.disposition].trace,
			});
		}

		// open component / MCP tool runs DURING generation (e.g. TTS) — place it adjacent to inference.
		if (f.mcpRan && message.mcp?.tool) {
			push({
				id: "mcp",
				layer: "model",
				node: null,
				title: "Open component · Hugging Face Space",
				detail: "Ran an open Space tool as part of this turn.",
				response: message.mcp.space
					? `${message.mcp.tool} · ${message.mcp.space}`
					: message.mcp.tool,
			});
		}

		// Agent-mode ACP tool execution (CUR-601) — real tools (write_file, terminal, code_execution) ran
		// during this turn. Placed adjacent to inference, same as the mcp block above, so the collapsed
		// spine (ProvenanceTrace.svelte) and this expanded log agree on a tool-running agent turn instead
		// of the collapsed view claiming "ran tools" while this one stayed silent.
		if (f.agentToolsRan && message.agentTools?.toolKinds?.length) {
			// counts (CUR-775) may be absent on a message persisted before this field existed — falls back
			// to the old flat kind-list line for those, never re-summarized from data it wasn't given.
			const summary = message.agentTools.counts ? summarizeToolRun(message.agentTools.counts) : "";
			push({
				id: "agent-tools",
				layer: "model",
				node: null,
				title: "Agent tool execution",
				detail: "Ran real tools as part of this turn.",
				response: summary || message.agentTools.toolKinds.join(", "),
			});
		}

		// A tool was ATTEMPTED but the open Space didn't respond in time (cold start) → we answered
		// without it. Surfaced (not silent) so intermittent tool usage is legible to the user — the
		// honesty stance: never let a degraded path look like normal behaviour.
		if (message.mcp?.skipped) {
			push({
				id: "mcp-skipped",
				layer: "model",
				node: null,
				status: "failed-open",
				title: "Open component · unavailable",
				detail:
					"An open Space tool was attempted but didn't respond in time, so the answer was produced without it.",
				response: message.mcp.skipMs
					? `skipped after ${Math.round(message.mcp.skipMs / 1000)}s`
					: "skipped",
			});
		}

		// ── output screen — defense-in-depth on the MODEL's answer, AFTER generation, before release.
		//    Only shown when output screening actually ran this turn (OUTPUT_MODERATION on); absent → no
		//    step, so we never imply the answer was checked when it wasn't. Mirrors the input pre-screen. ──
		if (f.outputScreen !== "unknown") {
			const outScreen: Step = {
				id: "output-screen",
				layer: "safety",
				node: SAFETY_NODES[0],
				title: "Output screen",
				detail:
					"Screened the model's answer sentence by sentence, releasing each part only after it cleared.",
			};
			if (f.outputScreen === "flagged") {
				const what = message.outputModeration?.truncated
					? "rest of the answer withheld"
					: "answer withheld";
				// ONLY the curated rule label is surfaced — never the raw `label` field, mirroring the input
				// safety step. Unknown/unlabeled rule → no parenthetical (no chance of leaking a raw action).
				const outLabel = message.outputModeration?.ruleLabel;
				// The guard never answered, so nothing was flagged; say the check could not finish. (CUR-3891)
				outScreen.response = message.outputModeration?.unscreened
					? `check could not finish — ${what}`
					: `flagged${outLabel ? ` (${outLabel})` : ""} — ${what}`;
			} else if (f.outputScreen === "failed-open") {
				outScreen.response = "screening unavailable — answer shown unscreened (failed open)";
				outScreen.status = "failed-open";
			} else {
				outScreen.response = "screened, no flag raised";
			}
			push(outScreen);
		}

		// ── honesty guards — post-generation; report ONLY corrections we actually recorded ────────────
		const corrections: string[] = [];
		if (message.nameNotice) corrections.push("removed a self-assigned name");
		if (message.urlNotice?.count)
			// "flagged", not "de-linked": the urlGuard KEEPS the link clickable and marks it (dotted
			// + "?"), it does not remove it, matching the on-answer UrlNotice chip ("clickable but marked
			// unverified").
			corrections.push(
				`flagged ${message.urlNotice.count} unverified link${message.urlNotice.count === 1 ? "" : "s"}`
			);
		if (message.labelNotice?.count)
			corrections.push(
				`removed ${message.labelNotice.count} mislabeled source name${message.labelNotice.count === 1 ? "" : "s"}`
			);
		if (message.sourceNotice) corrections.push("removed a fabricated source list");
		if (message.groundedHedgeNotice) {
			const { kind, sourceCount } = message.groundedHedgeNotice;
			corrections.push(
				kind === "regen"
					? "searched, then answered from what it already knows"
					: sourceCount > 0
						? `replaced the answer with a pointer to ${sourceCount} retrieved source${sourceCount === 1 ? "" : "s"}`
						: "replaced the answer with a pointer to retrieved reference material"
			);
		}
		push({
			id: "guards",
			layer: "verify",
			node: null,
			title: "Honesty guards",
			detail:
				"Checked the answer for a self-assigned name, unverifiable links, mislabeled sources, and a fabricated source list.",
			response: corrections.length ? corrections.join("; ") : "no corrections made",
		});

		// ── fact check — groundcheck (CUR-2765). Only when it ran; a check that never finished says so
		//    in place of passing for one that did. ──
		if (message.groundcheckNotice) {
			const { response, status } = groundcheckResponse(message.groundcheckNotice.outcome, message.groundcheckNotice.removed);
			push({
				id: "groundcheck",
				layer: "verify",
				node: null,
				title: "Fact check",
				detail: "Checked each claim in the answer against the retrieved sources, deleting the ones no source supports.",
				response,
				status,
			});
		}

		// ── persist — best-effort; honest "saved", no "survives reload" guarantee ─────────────────────
		push({
			id: "persist",
			layer: "data",
			node: null,
			title: "Conversation store · Postgres database",
			detail: "Saved the answer to the conversation in our Postgres database.",
			// real cumulative total time (request-start → done), where we measured it
			timingMs: message.timings?.totalMs ?? null,
		});
	}

	// ── collective second opinion — a SEPARATE, later opt-in request, shown last so it never implies
	//    it ran inline with the original turn. ──────────────────────────────────────────────────────
	if (f.verified) {
		const panelN = message.opinions?.length ?? 0;
		push({
			id: "second-opinion",
			layer: "verify",
			node: null,
			title: "Collective second opinion · later, on request",
			detail:
				"A separate request fanned this question out to other open models to cross-check the answer.",
			response: message.verdict
				? `${panelN} model${panelN === 1 ? "" : "s"} · ${message.verdict.agreement} agreement`
				: `${panelN} model${panelN === 1 ? "" : "s"}`,
		});
	}

	return steps;
}

function groundcheckResponse(outcome: GroundcheckOutcome, removed?: number): { response: string; status: TraceStatus } {
	switch (outcome) {
		case "revised":
			return { response: removedClaimsPhrase(removed), status: "ok" };
		case "emptied":
			return { response: "no claim was supported; replaced the answer with a pointer to the sources", status: "ok" };
		case "clean":
		case "kept":
			return { response: "checked, nothing removed", status: "ok" };
		case "truncated":
			return { response: "not checked: the sources were too long to check in full; answer shown as written", status: "failed-open" };
		case "too-many":
			return { response: "not checked: the checker disagreed with most of the answer, so it was left as written", status: "failed-open" };
		case "detect-failed":
		case "revise-failed":
			return { response: "not checked: the checker didn't finish in time; answer shown as written", status: "failed-open" };
		case "stood-down":
			return { response: "not checked: its figures came from code, or a guard had already rewritten it", status: "ok" };
	}
}
