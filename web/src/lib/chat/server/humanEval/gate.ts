import { flagEnabledOr } from "$lib/chat/server/flags";
import { isTestDeployment } from "$lib/chat/server/deployEnv";

/** PostHog flag key. Owner: chat. Ticket: CUR-1914. */
export const HUMAN_EVAL_FLAG = "human-eval";

/** Is the human evaluation flow (API and entry point on the models page) on for this request? */
export function humanEvalEnabled(): boolean {
	return flagEnabledOr(HUMAN_EVAL_FLAG, () => false);
}

/**
 * Languages whose task set is still a draft open on preview and in local development, so the flow
 * can be tried before a speaker has checked the translations. Never in production, and never where
 * no environment is declared: a draft stays closed there.
 */
export function includeDraftLanguages(): boolean {
	return isTestDeployment();
}
