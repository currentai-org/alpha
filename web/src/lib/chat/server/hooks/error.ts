import type { HandleServerError } from "@sveltejs/kit";
import { logger } from "$lib/chat/server/logger";
import { captureServerException } from "$lib/chat/server/errorTracking";

type HandleServerErrorInput = Parameters<HandleServerError>[0];

export async function handleServerError({
	error,
	event,
	status,
	message,
}: HandleServerErrorInput): Promise<App.Error> {
	// handle 404
	if (event.route.id === null) {
		return {
			message: `Page ${event.url.pathname} not found`,
		};
	}

	const errorId = crypto.randomUUID();

	// Not `event.locals` and not `event.request`: locals carries the user record (email, name) and,
	// for a Hugging Face session, the live OAuth access token; the request carries cookies and the
	// Authorization header. Logging either would ship all of it to the log store. Route + ids are enough to find it.
	//
	// The caught error goes under `err`, never `error`. Pino's `errorKey` default is `err`
	// (loggerOptions.ts leaves it untouched) — only that exact key gets the built-in serializer.
	// `Error#message`/`#stack` are non-enumerable, so a plain `error:` field serializes to `{}` and
	// the line's own message falls back to SvelteKit's generic "Internal Error". Under `error:` a
	// Postgres auth-failure object logs as `error:{}`; under `err:` it logs its real message plus stack. (CUR-1589)
	logger.error({
		url: event.request.url,
		method: event.request.method,
		routeId: event.route.id,
		params: event.params,
		sessionId: event.locals.sessionId,
		userId: event.locals.user?._id ? String(event.locals.user._id) : undefined,
		message,
		err: error,
		errorId,
		status,
	});

	// Grouping + counts + the rate alert. Awaited so the report is sent before a serverless instance can
	// freeze, but it never throws — an error handler must not fail (see errorTracking.ts).
	// Same errorId the user is shown, so "I saw error abc123" maps to one grouped exception.
	await captureServerException(error, {
		errorId,
		url: event.url.href,
		routeId: event.route.id,
		status,
		method: event.request.method,
	});

	return {
		message: "An error occurred",
		errorId,
	};
}
