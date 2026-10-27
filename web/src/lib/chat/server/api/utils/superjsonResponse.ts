import superjson from "superjson";
import type { NoSecretFields } from "./noSecretFields";

/**
 * Create a JSON response serialized with superjson.
 * Matches the wire format of the former Elysia `mapResponse` hook. `data` may not carry a
 * secret-named field (see noSecretFields.ts).
 */
type NotPromise<T> = T extends Promise<unknown> ? never : T;

export function superjsonResponse<T>(
	data: NotPromise<T> & NoSecretFields<T>,
	init?: ResponseInit
): Response {
	return new Response(superjson.stringify(data), {
		...init,
		headers: {
			"Content-Type": "application/json",
			...init?.headers,
		},
	});
}
