import type { RequestHandler } from "@sveltejs/kit";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { collections } from "$lib/chat/server/database";
import { authCondition } from "$lib/chat/server/auth";
import { isAssistantGenerationTerminal, isGenerationStale } from "$lib/chat/utils/generationState";
import type { Message } from "$lib/chat/types/Message";
// The stream's lifetime and the platform kill it must stay under live in ./lifetime.ts (SvelteKit
// forbids non-handler exports from +server.ts, and updates.lifetime.spec.ts pins their margin).
import { MAX_LIFETIME_MS } from "./lifetime";

/**
 * SSE endpoint that pushes conversation-update events to the client.
 *
 * The client opens this stream while background generations are in flight.
 * Because generations may complete on any pod, this handler uses a server-side
 * poll loop (every ~2 s) rather than in-process events.
 *
 * Protocol
 * --------
 * Each SSE event has type "update" and a JSON payload:
 *   { id: string, title: string, updatedAt: string (ISO), isTerminal: boolean }
 *
 * The client reconnects automatically (SSE default) after the server closes
 * the stream at MAX_LIFETIME_MS; it should pass the last known cursor via
 * the `?cursor` query parameter to avoid re-sending stale events on reconnect.
 *
 * Multi-instance safety
 * ---------------------
 * We query the database directly on every tick (the Mongo-shaped `collections` adapter, backed by
 * Postgres — see database.ts), so updates written by any pod are visible here without in-process
 * coordination.
 */

const POLL_INTERVAL_MS = 2_000;

type ConvUpdate = {
	id: string;
	title: string;
	updatedAt: string;
	isTerminal: boolean;
};

export const GET: RequestHandler = async ({ locals, url, request }) => {
	requireAuth(locals);

	// `cursor` is an ISO timestamp; events with updatedAt > cursor are sent.
	// On the very first connection the client passes cursor=0 (epoch) so all
	// in-flight conversations are surfaced immediately.
	// Resume order: prefer the SSE `Last-Event-ID` header — the browser's built-in auto-reconnect (a
	// transient wifi drop within the stream's lifetime) replays the URL verbatim but adds this header set
	// to the last event id it received, which is fresher than the now-stale `?cursor` baked into that URL.
	// Fall back to the explicit `?cursor` the client opens with (used by the poller's own reconnect, which
	// builds a fresh URL and sends no Last-Event-ID), then epoch. We emit `id:` = each event's updatedAt
	// (see `encode` below) so a reconnect resumes server-side instead of re-walking from epoch.
	// An unparseable cursor yields an Invalid Date whose NaN time BSON-serializes
	// as epoch while never advancing (NaN comparisons are false), so every tick
	// would re-emit up to 50 conversations for the stream's whole lifetime.
	// Treat invalid cursors as epoch instead.
	const cursorParam = request.headers.get("last-event-id") || url.searchParams.get("cursor");
	const parsedCursor = cursorParam ? new Date(cursorParam) : null;
	let cursor = parsedCursor && !isNaN(parsedCursor.getTime()) ? parsedCursor : new Date(0);

	const stream = new ReadableStream({
		async start(controller) {
			const signal = request.signal;
			const deadline = Date.now() + MAX_LIFETIME_MS;

			// Emit `id:` = the event's updatedAt so the browser's built-in reconnect echoes it back as the
			// `Last-Event-ID` header and we resume from there (see cursor resolution above).
			const encode = (data: ConvUpdate) =>
				new TextEncoder().encode(
					`id: ${data.updatedAt}\nevent: update\ndata: ${JSON.stringify(data)}\n\n`
				);

			const sendHeartbeat = () => controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));

			while (!signal.aborted && Date.now() < deadline) {
				// Wait for next tick (or abort)
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, POLL_INTERVAL_MS);
					signal.addEventListener(
						"abort",
						() => {
							clearTimeout(t);
							resolve();
						},
						{ once: true }
					);
				});

				// Re-check the deadline after the tick too: the query/emit work below has no bound of its
				// own, so entering it just before the deadline is the loop's only overshoot — keep it to
				// at most one poll's work past MAX_LIFETIME_MS.
				if (signal.aborted || Date.now() >= deadline) break;

				try {
					// Find conversations belonging to this user that changed since cursor.
					// We project just enough to determine terminal state without loading
					// full message content (only metadata fields on the last assistant message).
					const changed = await collections.conversations
						.find({
							...authCondition(locals),
							updatedAt: { $gt: cursor },
						})
						.project<{
							_id: { toString(): string };
							title: string;
							updatedAt: Date;
							messages: Array<
								Pick<Message, "from" | "interrupted" | "updates"> & { content?: string }
							>;
						}>({
							title: 1,
							updatedAt: 1,
							// Project only the fields isAssistantGenerationTerminal needs.
							// We cannot do a sparse projection of only the last message from the
							// Mongo-shaped adapter without an aggregation stage, so we project all
							// messages but limit to the fields we need (not the large content strings).
							"messages.from": 1,
							"messages.interrupted": 1,
							"messages.updates": 1,
						})
						// Oldest first keeps the cursor replay-safe: events are emitted in
						// chronological order, so a reconnect with the last received
						// updatedAt never skips older events from a partially delivered
						// batch, and limit() truncates the NEWEST records, which remain
						// beyond the cursor and are picked up on the next tick.
						.sort({ updatedAt: 1 })
						.limit(50)
						.toArray();

					for (const conv of changed) {
						if (signal.aborted) break;

						const lastAssistant = [...conv.messages]
							.reverse()
							.find((m) => m.from === "assistant") as Message | undefined;
						// ABSENT != TERMINAL. A conversation with NO assistant row has no server-recorded
						// turn — so it is not terminal. Reporting it terminal would tell a client that is
						// optimistically holding a turn (whose POST was lost before any pod recorded it) to
						// wipe that turn, leaving an empty conversation. (`isAssistantGenerationTerminal`
						// returns true for an absent message — correct for "is it actively generating?", wrong
						// for "should the client stop tracking?" — so gate the whole verdict on `started`.)
						// Only a genuinely finished turn, or a turn that DID start and then went stale (its pod
						// died mid-generation), is terminal. The client's own in-flight guard + the poller's
						// MAX_TRACK_DURATION_MS eviction clean up an optimistic turn that never reaches a pod.
						const started = lastAssistant !== undefined;
						const isTerminal =
							started &&
							(isAssistantGenerationTerminal(lastAssistant) || isGenerationStale(conv.updatedAt));

						const event: ConvUpdate = {
							id: conv._id.toString(),
							title: conv.title,
							updatedAt: conv.updatedAt.toISOString(),
							isTerminal,
						};

						controller.enqueue(encode(event));

						// Advance cursor to avoid re-emitting the same conversation on
						// the next tick (use max of current cursor and this conv's updatedAt).
						if (conv.updatedAt > cursor) {
							cursor = conv.updatedAt;
						}
					}

					if (changed.length === 0) {
						sendHeartbeat();
					}
				} catch (err) {
					// Log and continue — transient DB errors should not kill the stream.
					console.error("[conversation-updates SSE] poll error", err);
					sendHeartbeat();
				}
			}

			// Graceful close: tell the client it should reconnect.
			try {
				controller.close();
			} catch {
				// already closed by abort
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			// Allow client-side JS to read this response (CORS if needed)
			"X-Accel-Buffering": "no",
		},
	});
};
