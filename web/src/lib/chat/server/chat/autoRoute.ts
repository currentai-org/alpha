import { catalog, servedKey } from "$lib/chat/routing/catalog";
import type { ChatRequestPayload } from "./requestSchema";
import type { Message } from "$lib/chat/types/Message";

/**
 * Auto's choice for this turn as the answer stores it (CUR-3944), or undefined. Auto decides in the
 * browser, so the server keeps the claim only when the catalog model it names is the model this turn
 * actually runs on: a stale or mismatched claim would put "Auto chose X" over an answer Y wrote.
 * A retry re-runs an earlier question, which Auto did not judge again, so it records nothing, unless
 * it is Auto's re-pick of a question its first choice did not answer (CUR-4384), which Auto did judge
 * again and which names a different model from the one it replaces.
 */
export function autoRouteForTurn(
	claim: ChatRequestPayload["autoRoute"],
	turnModelId: string,
	isRetry: boolean | undefined
): Message["autoRoute"] {
	if (!claim) return undefined;
	const repickedFrom = claim.repickedFrom?.trim() || undefined;
	if (isRetry && !repickedFrom) return undefined;
	const chosen = catalog.find((m) => m.id === claim.model);
	if (!chosen?.gatewayId || servedKey(chosen.gatewayId) !== servedKey(turnModelId)) return undefined;
	if (repickedFrom && repickedFrom === chosen.id) return undefined;
	return {
		model: chosen.id,
		reasons: claim.reasons.map((r) => r.trim()).filter(Boolean),
		explanation: claim.explanation.trim(),
		...(repickedFrom ? { repickedFrom } : {}),
	};
}
