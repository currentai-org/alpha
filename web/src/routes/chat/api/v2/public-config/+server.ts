// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { getLayoutPublicConfig } from "$lib/chat/server/layoutData";

const PUBLIC_CONFIG_CACHE_HEADERS = { "Cache-Control": "private, max-age=60" };

export const GET: RequestHandler = async () => {
	return superjsonResponse(await getLayoutPublicConfig(), {
		headers: PUBLIC_CONFIG_CACHE_HEADERS,
	});
};
