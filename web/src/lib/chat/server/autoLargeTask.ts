// The model a self-hosted operator names for large tasks (AUTO_LARGE_TASK_MODEL), such as the frontier
// endpoint they list after their own in OPENAI_API_BASE_URLS. Auto ranks only catalogued models, so on a
// stack serving none of them every turn would stay on the default model; with this set, a turn Auto grades
// large goes to the named model instead (routing/choice.ts). The browser gets the id in the layout data.
//
// A name that matches no served model is a misconfiguration: it is logged as an error, once, and Auto
// keeps every turn on the default model rather than sending one to a model that is not there.
import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";

let warnedFor: string | undefined;

/** The served id AUTO_LARGE_TASK_MODEL names, or undefined when it is unset or names no served model. */
export function autoLargeTaskModel(
	servedIds: readonly string[],
	wanted: string | undefined = config.AUTO_LARGE_TASK_MODEL
): string | undefined {
	const id = (wanted ?? "").trim();
	if (!id) return undefined;
	if (servedIds.includes(id)) return id;
	if (warnedFor !== id) {
		warnedFor = id;
		logger.error(
			{ autoLargeTaskModel: id, served: servedIds },
			"[routing] AUTO_LARGE_TASK_MODEL names no served model; Auto keeps large tasks on the default model"
		);
	}
	return undefined;
}
