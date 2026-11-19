import { error } from "@sveltejs/kit";
import { ObjectId } from "bson";
import { authCondition } from "$lib/chat/server/auth";
import { collections } from "$lib/chat/server/database";
import { createFollowStream } from "$lib/chat/server/chat/generationFollow";
import {
	generationLogState,
	readGenerationEvents,
	readGenerationForFollow,
} from "$lib/chat/server/db/generationEvents";
import { STREAM_FOLLOW_FLAG, streamFollowEnabled } from "$lib/chat/server/streamFollowGate";
import { logger } from "$lib/chat/server/logger";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

/**
 * Follow a turn's stream after the connection that carried it dropped.
 *
 * Replays what the turn sent from the start (or after `?after=<seq>`) and keeps reading until the
 * answer ends. A reader only: closing it never stops the turn, and a stopped turn's follow ends with
 * the saved, clamped answer. 404 means there is nothing to follow (flag off, unknown generation, the
 * log already deleted); the client then waits for the saved copy as it did before.
 */
export async function GET({ params, locals, url }) {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");
	if (!streamFollowEnabled()) {
		// A follower only asks once the page was told the flag is on, so this is a flag that flipped mid-turn.
		logger.debug({ flag: STREAM_FOLLOW_FLAG }, "[stream-follow] follow asked while the flag is off");
		error(404, "Not found");
	}
	if (!ObjectId.isValid(params.id)) error(404, "Not found");

	const conversationId = new ObjectId(params.id);
	const conversation = await collections.conversations.findOne({
		_id: conversationId,
		...authCondition(locals),
	});
	if (!conversation) error(404, "Not found");

	const generationId = params.generationId;
	const generation = await readGenerationForFollow(generationId);
	if (!generation || generation.conversationId !== conversationId.toString()) error(404, "Not found");

	// A finished turn whose rows are gone has nothing to replay.
	const state = await generationLogState(generationId);
	if (state.count === 0 && generation.status !== "in_flight") error(404, "Not found");

	// Absent means from the start (-1, so seq 0 is replayed); Number(null) would read as 0 and skip it.
	const afterParam = url.searchParams.has("after") ? Number(url.searchParams.get("after")) : -1;
	const after = Number.isInteger(afterParam) && afterParam >= -1 ? afterParam : -1;

	const body = createFollowStream(
		{
			readEvents: (afterSeq) => readGenerationEvents(generationId, afterSeq),
			isTerminal: async () =>
				(await readGenerationForFollow(generationId))?.status !== "in_flight",
			savedFinalAnswer: async () => {
				if (!generation.messageId) return undefined;
				const saved = await collections.conversations.findOne({ _id: conversationId });
				const message = saved?.messages.find((m) => m.id === generation.messageId);
				return message?.updates?.find(
					(u): u is MessageUpdate => u.type === MessageUpdateType.FinalAnswer
				);
			},
		},
		{ after }
	);

	return new Response(body, {
		headers: {
			"Content-Type": "application/jsonl",
			"Cache-Control": "no-store, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
