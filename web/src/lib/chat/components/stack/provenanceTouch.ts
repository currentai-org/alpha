import type { ProvenanceFacts } from "$lib/chat/utils/trace/provenanceFacts";
import { CATALOG_RAG_NODE, SYFTHUB_RAG_NODE, EPFL_RAG_NODE } from "./reveal";

const TOUCHED_ON_ANSWER = new Set([
	"chat",
	"foundation-model",
	"inference-engine",
	"compute-router",
	"inference-platform",
	"api-management",
	"stack-provenance",
]);

function safetyChecked(f: ProvenanceFacts): boolean {
	return (
		f.screen === "clear" ||
		f.screen === "flagged" ||
		f.outputScreen === "clear" ||
		f.outputScreen === "flagged"
	);
}

function privacyTouched(f: ProvenanceFacts): boolean {
	return (
		f.vault || f.ragHits.some((h) => h.node === SYFTHUB_RAG_NODE || h.node === EPFL_RAG_NODE)
	);
}

function catalogRagTouched(f: ProvenanceFacts): boolean {
	return f.ragHits.some((h) => h.node === CATALOG_RAG_NODE);
}

/** Open-web search ran (grounded or an honest ungrounded round-trip). */
function webSearchTouched(f: ProvenanceFacts): boolean {
	return f.webCount > 0 || f.searchRan;
}

/** Whether a provenance product was involved in answering this turn. */
export function provenanceTouch(productName: string, facts: ProvenanceFacts): boolean {
	if (TOUCHED_ON_ANSWER.has(productName)) {
		return facts.answered && !facts.servedFromCache;
	}
	// The card says the answer ran on sovereign compute in Switzerland, so it lights only when the
	// backend that served this turn is on the Swiss allowlist. Every gateway lane outside it, and a turn
	// with no recorded backend, leaves it dark (CUR-1883).
	if (productName === "sovereign-compute")
		return facts.answered && !facts.servedFromCache && facts.swissCompute;
	if (productName === "trust-and-safety") return safetyChecked(facts);
	if (productName === "federated-rag") return privacyTouched(facts);
	// mcpRan (open HF Space tool) and agentToolsRan (real ACP tool execution, CUR-601) are two distinct
	// mechanisms that both mean "agent-service did something this turn" — OR'd, not replaced, so the
	// existing MCP-triggers-touch behavior keeps working for a turn with zero ACP tool use.
	if (productName === "agent-service") return facts.mcpRan || facts.agentToolsRan;
	if (productName === "rag") return catalogRagTouched(facts);
	if (productName === "web-search") return webSearchTouched(facts);
	// voice-output lights ONLY when this turn actually produced a TTS clip (message.mcp.audio), not on
	// every answer. Read-aloud is currently hidden, so no clip is produced and the node stays dark; if
	// voice returns, it lights honestly per-turn like every other product here.
	if (productName === "voice-output") return facts.voiced;
	return false;
}
