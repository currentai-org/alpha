import { m } from '$lib/paraglide/messages.js';
import { catalog } from './catalog';
import type { AutoRouteNote } from './state';

/** A catalog model's name for a sentence, or its id when the catalog no longer lists it. */
export function catalogName(id: string): string {
	return catalog.find((model) => model.id === id)?.name ?? id;
}

/** What the conversation page knows about a turn that just failed (CUR-4384). */
export interface FailedTurn {
	/** The `auto-repick` flag, as the layout data shipped it. */
	enabled: boolean;
	/** Auto's choice the turn was sent with; undefined when the person picked the model. */
	autoRoute: AutoRouteNote | undefined;
	isRetry: boolean;
	attach: boolean;
	/** The in-stream error's status: 429 when the model's host refused, 404 or 5xx when it is not served. */
	statusCode: number | undefined;
	/** The server's mark for a model that sent nothing before its give-up. */
	modelSilent: boolean;
	/** Any text or tool result reached the page before the failure. */
	contentSeen: boolean;
}

/**
 * Whether a failed turn says its model answered nobody: its host refused (429), has no working entry for
 * it (404, CUR-4629), failed on its side (5xx), or the model
 * sent nothing before its give-up. The tab marks such a model busy (busyHere.ts), so Auto's next choice,
 * this turn's re-pick included, goes elsewhere. A 400 or 401 is about our request and counts for none.
 * @internal exported for its unit tests
 */
export function modelAnsweredNobody(statusCode: number | undefined, modelSilent: boolean): boolean {
	if (modelSilent) return true;
	if (statusCode === undefined) return false;
	return statusCode === 429 || statusCode === 404 || (statusCode >= 500 && statusCode <= 599);
}

/**
 * Whether a failed turn marks the model the conversation is on busy in this tab (busyHere.ts), which
 * then shows the composer's "unavailable right now" notice for it. Only a failure of that model does
 * (modelAnsweredNobody). A turn the agent served (`route` "agent", from the turn's router metadata)
 * never does (CUR-4661): agent-service ran it, so the route's watchdog ending a run whose approval
 * nobody answered, or a stall in the agent's own steps, says nothing about the chosen model, which was
 * never called. The server's own mark already leaves agent turns out (watchdogCountsTowardBusy).
 */
export function failureMarksModelBusy(turn: {
	statusCode: number | undefined;
	modelSilent: boolean;
	route: string | undefined;
}): boolean {
	if (turn.route === 'agent') return false;
	return modelAnsweredNobody(turn.statusCode, turn.modelSilent);
}

/**
 * Whether Auto should pick again for this failed turn: Auto chose its model, that model answered nobody
 * (modelAnsweredNobody), and no answer text reached the visitor. Never for a hand pick, a retry, a
 * re-attached agent task, a turn that already showed text, or a turn that is itself a re-pick, so a
 * question is re-picked at most once.
 */
export function shouldRepick(turn: FailedTurn): boolean {
	if (!turn.enabled || !turn.autoRoute || turn.autoRoute.repickedFrom) return false;
	if (turn.isRetry || turn.attach || turn.contentSeen) return false;
	return modelAnsweredNobody(turn.statusCode, turn.modelSilent);
}

/**
 * Auto's new note for the re-picked turn: its new choice, with a first sentence naming the model it
 * replaced. Undefined when Auto chose the same model again, which leaves the error standing.
 */
export function repickedNote(failedFrom: string, next: AutoRouteNote): AutoRouteNote | undefined {
	if (next.model === failedFrom) return undefined;
	const said = m.routing_repicked({ from: catalogName(failedFrom), to: catalogName(next.model) });
	return { ...next, explanation: `${said} ${next.explanation}`.trim(), repickedFrom: failedFrom };
}

/**
 * The live log's line while Auto waits on its choice's first word (CUR-4384): shown once the model has
 * used half of its wait, so a visitor knows before the give-up that Auto will ask another model.
 * Undefined before then, once the model has started (answer text, a provenance frame naming it, or a
 * search with sources; after that the silent give-up no longer applies, so the line's promise would not
 * hold, CUR-4629), or for any answer but the one Auto is waiting on.
 */
export function slowToStartLine(input: {
	wait: { answerId: string; model: string; waitMs: number } | null;
	answerId: string;
	elapsedMs: number;
	/** The model has started: answer text, a provenance frame naming it, or a search with sources. */
	started: boolean;
}): string | undefined {
	const { wait } = input;
	if (!wait || wait.answerId !== input.answerId || input.started) return undefined;
	if (input.elapsedMs < wait.waitMs / 2) return undefined;
	return m.routing_slowToStart({ model: catalogName(wait.model) });
}
