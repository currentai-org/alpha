import type { RequestHandler } from "@sveltejs/kit";
import { syncGate } from "$lib/chat/server/sync/syncGate";
import { readChanges } from "$lib/chat/server/sync/syncChanges";
import { verifySyncAccessToken } from "$lib/chat/server/sync/syncToken";
import { decodeCursor } from "$lib/chat/server/sync/syncWire";
import { MAX_LIFETIME_MS } from "../../conversations/updates/lifetime";

const POLL_INTERVAL_MS = 2_000;

/**
 * GET /chat/api/v2/sync/changes (CUR-4312): Server-Sent Events of `event: changes`, data
 * `{"v":1,cursor,conversations,tombstones}`, with `id:` = the cursor so a reconnect resumes from
 * Last-Event-ID. The first events page through everything after the cursor (all of it, from an empty
 * cursor), then the stream polls every two seconds and sends only when something changed. It closes
 * after MAX_LIFETIME_MS like the updates stream, and earlier when the token is revoked or expires
 * (re-checked on every poll). The flag is read once per connection, so turning it off takes effect
 * within one lifetime.
 */
export const GET: RequestHandler = async ({ locals, url, request }) => {
	const caller = syncGate(locals);
	if (caller instanceof Response) return caller;

	const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
	let since = decodeCursor(request.headers.get("last-event-id") || url.searchParams.get("cursor"));
	const enc = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const signal = request.signal;
			const deadline = Date.now() + MAX_LIFETIME_MS;
			const send = (s: string) => controller.enqueue(enc.encode(s));
			try {
				let first = true;
				while (!signal.aborted && Date.now() < deadline) {
					const { event, more, cursor } = await readChanges(caller.user._id, since);
					if (first || event.conversations.length || event.tombstones.length) {
						send(`id: ${event.cursor}\nevent: changes\ndata: ${JSON.stringify(event)}\n\n`);
					} else {
						send(": heartbeat\n\n");
					}
					first = false;
					since = cursor;
					if (more) continue;
					await new Promise<void>((resolve) => {
						const t = setTimeout(resolve, POLL_INTERVAL_MS);
						signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
					});
					if (signal.aborted || Date.now() >= deadline) break;
					const still = await verifySyncAccessToken(token);
					if (!still.ok) break;
				}
			} catch {
				// The client reconnects with its last cursor; nothing is lost by ending the stream here.
			} finally {
				try {
					controller.close();
				} catch {
					/* already closed by the client going away */
				}
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
};
