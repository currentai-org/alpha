// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { HandleFetch } from "@sveltejs/kit/hooks";
import { isHostLocalhost } from "$lib/chat/server/isURLLocal";

type HandleFetchInput = Parameters<HandleFetch>[0];

export async function handleFetchRequest({
	event,
	request,
	fetch,
}: HandleFetchInput): Promise<Response> {
	if (isHostLocalhost(new URL(request.url).hostname)) {
		const cookieHeader = event.request.headers.get("cookie");
		if (cookieHeader) {
			const headers = new Headers(request.headers);
			headers.set("cookie", cookieHeader);

			return fetch(new Request(request, { headers }));
		}
	}

	return fetch(request);
}
