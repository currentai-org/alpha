import { NoFirstChunkError } from "$lib/chat/server/endpoints/failover";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

// A picked model's last lane that sends nothing gives up at its deadline (failover.ts) instead
// of waiting out the route's 45s watchdog. The visitor sees the same sentence the watchdog would have
// shown, sooner, and the error's 504 carries through as the status.
// (CUR-3939)
// The sentence names the model, as the busy notice does (upstreamBusy.ts), so a person who
// picked a model is told which one didn't answer. (CUR-3295)

/** The visitor-facing sentence for a turn that ran out of time before `modelName` answered. */
function timedOutMessage(modelName: string): string {
	return `${modelName} took too long to respond. Please try again.`;
}

/** The visitor-facing message for a generation error, or null when no lane ever sent a first chunk. */
export function upstreamSilentMessage(err: unknown, modelName: string): string | null {
	if (!(err instanceof NoFirstChunkError)) return null;
	return timedOutMessage(modelName);
}

// The generation watchdog also fires when our own step stalls (a web search, an agent or MCP
// tool, retrieval), and naming the model then blames it for our wait. Those turns get the plain sentence. (CUR-4107)
const TOOL_STEP_TYPES: ReadonlySet<MessageUpdateType> = new Set([
	MessageUpdateType.AgentStep,
	MessageUpdateType.AgentRun,
	MessageUpdateType.AgentTools,
	MessageUpdateType.WebSearch,
	MessageUpdateType.SearchAttempt,
	MessageUpdateType.Mcp,
	MessageUpdateType.McpCall,
	MessageUpdateType.Rag,
]);

/** The generic sentence, for a timeout that is not the model's alone. */
const GENERIC_TIMED_OUT_MESSAGE = "The request took too long to respond. Please try again.";

/**
 * The visitor-facing sentence when the generation watchdog fires. `generationUpdatesFrom` is how many
 * updates the turn held when the model call began, or undefined if retrieval never finished; only
 * updates after it count, since a search stamped before the call says nothing about who stalled.
 */
export function watchdogTimedOutMessage(
	updates: readonly MessageUpdate[] | undefined,
	generationUpdatesFrom: number | undefined,
	modelName: string
): string {
	return watchdogBlamesModel(updates, generationUpdatesFrom)
		? timedOutMessage(modelName)
		: GENERIC_TIMED_OUT_MESSAGE;
}

/** Whether a watchdog stall is the model's own: the model call had begun and none of our tool steps ran after it. */
function watchdogBlamesModel(
	updates: readonly MessageUpdate[] | undefined,
	generationUpdatesFrom: number | undefined
): boolean {
	if (generationUpdatesFrom === undefined) return false;
	return !(updates ?? []).slice(generationUpdatesFrom).some((u) => TOOL_STEP_TYPES.has(u.type));
}

/**
 * CUR-4345. Whether a turn the generation watchdog ended counts toward the model's busy mark
 * (modelBusy.ts). A model with no last-lane give-up (harnessProfiles.ts `silentGiveUpMs`), such as SEA-LION and
 * ALIA, signals failure only this way, and failover.ts cannot tell this abort from a
 * visitor's Stop, so the route decides it. It counts only when the model sent no token at all (a slow
 * answer still writing is not busy), the stall was the model's (the CUR-4107 rule above), no fault was
 * injected (the mark is shared by everyone on the deployment), and the model is a served gateway model.
 */
export function watchdogCountsTowardBusy(turn: {
	updates: readonly MessageUpdate[] | undefined;
	generationUpdatesFrom: number | undefined;
	firstTokenAt: Date | undefined;
	faultInjected: boolean;
	isAgentTurn: boolean;
	isLocalModel: boolean;
}): boolean {
	return (
		turn.firstTokenAt === undefined &&
		!turn.faultInjected &&
		!turn.isAgentTurn &&
		!turn.isLocalModel &&
		watchdogBlamesModel(turn.updates, turn.generationUpdatesFrom)
	);
}
