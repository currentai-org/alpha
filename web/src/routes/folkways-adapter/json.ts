// Folkways adapter — the one JSON response its routes send. The body type refuses a secret-named
// field the way the chat API's `json` does (CUR-2643).

import type { NoSecretFields } from '$lib/chat/server/api/utils/noSecretFields';

export const json = <T>(status: number, body: T & NoSecretFields<T>) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
