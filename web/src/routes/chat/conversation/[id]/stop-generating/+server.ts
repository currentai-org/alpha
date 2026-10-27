import { authCondition } from "$lib/chat/server/auth";
import { collections } from "$lib/chat/server/database";
import { AbortRegistry } from "$lib/chat/server/abortRegistry";
import { readGeneration } from "$lib/chat/server/generations";
import { logger } from "$lib/chat/server/logger";
import { clampFinishedMessage } from "$lib/chat/server/stopTruncation";
import { agentModelLaneInput } from "$lib/chat/server/models";
import { cancelAgentTask } from "$lib/chat/server/endpoints/agent/endpointAgent";
import { error } from "@sveltejs/kit";
import { ObjectId } from "bson";
import { z } from "zod";

const stopPointSchema = z.object({
	generationId: z.string().uuid(),
	seenContentLength: z.number().int().nonnegative(),
});

/**
 * Ideally, we'd be able to detect the client-side abort, see https://github.com/huggingface/chat-ui/pull/88#issuecomment-1523173850
 */
export async function POST({ params, locals, request }) {
	if (!locals.user && !locals.sessionId) {
		error(401, "Unauthorized");
	}

	const conversationId = new ObjectId(params.id);

	const conversation = await collections.conversations.findOne({
		_id: conversationId,
		...authCondition(locals),
	});

	if (!conversation) {
		error(404, "Conversation not found");
	}

	// Optional stop point from the stopping client (see AbortedGeneration).
	// Parsed leniently: a stop must succeed even with a missing or malformed
	// body (legacy clients send none).
	let stopPoint: z.infer<typeof stopPointSchema> | undefined;
	try {
		stopPoint = stopPointSchema.parse(await request.json());
	} catch {
		stopPoint = undefined;
	}

	// Write the marker before aborting the in-process registry so a finalize
	// triggered by a same-pod abort always finds the stop point on it.
	await collections.abortedGenerations.updateOne(
		{ conversationId },
		{
			$set: { updatedAt: new Date(), ...stopPoint },
			$setOnInsert: { createdAt: new Date() },
		},
		{ upsert: true }
	);

	AbortRegistry.getInstance().abort(conversationId.toString());

	if (stopPoint) {
		await clampIfAlreadyFinished(conversationId, stopPoint).catch((err) =>
			logger.warn(err, "[stop] could not apply the stop point to a finished answer")
		);
		await closeAgentRun(conversationId, stopPoint.generationId, locals).catch((err) =>
			logger.warn(err, "[stop] could not cancel the stopped turn's agent task")
		);
	}

	return new Response();
}

// How long to wait for the stopped generation to reach a terminal state. An abort normally unwinds
// in well under a second; a cross-pod stop waits on the marker watcher's poll as well.
const SETTLE_POLLS = 12;
const SETTLE_POLL_MS = 400;

/**
 * Apply the stop point to an answer that had already finished on the server (CUR-2306).
 *
 * The generation's own finalize clamps an aborted run to the stop point. A run that completed
 * before the stop arrived has no abort to unwind, so without this the reload shows the whole
 * answer, including the part smooth mode had not yet revealed when Stop was pressed. This waits
 * for the generation to settle, then clamps the stored message; a run that was really aborted
 * is already at or under the stop point, so the clamp finds nothing left to do. The client
 * awaits this response before it reloads.
 */
async function clampIfAlreadyFinished(
	conversationId: ObjectId,
	stopPoint: z.infer<typeof stopPointSchema>
) {
	const generation = await settledGeneration(stopPoint.generationId);
	if (generation?.status !== "complete" || !generation.messageId) return;

	const conversation = await collections.conversations.findOne({ _id: conversationId });
	const message = conversation?.messages.find((m) => m.id === generation.messageId);
	if (!conversation || !message) return;
	const clamped = clampFinishedMessage(message, stopPoint.seenContentLength);
	if (!clamped) return;

	await collections.conversations.updateOne(
		{ _id: conversationId },
		{
			$set: {
				messages: conversation.messages.map((m) => (m.id === message.id ? { ...m, ...clamped } : m)),
				updatedAt: new Date(),
			},
		}
	);
}

async function settledGeneration(generationId: string) {
	let generation = await readGeneration(generationId);
	for (let i = 0; generation?.status === "in_flight" && i < SETTLE_POLLS; i++) {
		await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
		generation = await readGeneration(generationId);
	}
	return generation;
}

/**
 * Cancel the agent task a stopped turn started, and mark its handle closed (CUR-993).
 *
 * @remarks
 * A run outlives its tab, so aborting the turn's stream no longer ends it, and a reload would
 * re-attach to a run the person asked to stop. Read after the generation settles, because the
 * turn's own finalize writes the message (and its `agentRun`) as it unwinds. The conversation was
 * already found under `authCondition`, which is the visitor check agent-service cannot make.
 */
async function closeAgentRun(
	conversationId: ObjectId,
	generationId: string,
	locals: App.Locals
) {
	const generation = await settledGeneration(generationId);
	if (!generation?.messageId) return;
	const conversation = await collections.conversations.findOne({ _id: conversationId });
	const message = conversation?.messages.find((m) => m.id === generation.messageId);
	const run = message?.agentRun;
	if (!conversation || !message || !run || run.closed) return;

	// The same input the turn's lane was built from, so the cancel carries the service token and the
	// visitor's subject (CUR-4602). A bare registry entry fails the schema and no cancel is sent.
	const config = agentModelLaneInput();
	const startedAt = Date.now();
	const status = config ? await cancelAgentTask(config, locals, run) : undefined;
	const ms = Date.now() - startedAt;
	// 200 is a cancel or a task already finished, 404 a task the service no longer holds. Anything else
	// (a 401 or 403) leaves the task running, so the handle stays open and a reload still shows it.
	if (status !== undefined && status !== 200 && status !== 404) {
		logger.warn({ taskId: run.taskId, status, ms }, "[stop] agent-service refused to cancel the stopped turn's task");
		return;
	}
	if (!config) logger.warn({ taskId: run.taskId }, "[stop] no agent endpoint configured; the stopped turn's task was not cancelled");
	else logger.info({ taskId: run.taskId, status, ms }, "[stop] cancelled the stopped turn's agent task");

	await collections.conversations.updateOne(
		{ _id: conversationId },
		{
			$set: {
				messages: conversation.messages.map((m) =>
					m.id === message.id ? { ...m, agentRun: { ...run, closed: true } } : m
				),
				updatedAt: new Date(),
			},
		}
	);
}
