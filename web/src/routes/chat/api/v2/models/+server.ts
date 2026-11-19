// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { getLayoutModels } from "$lib/chat/server/layoutData";

// `private` is load-bearing: the list now varies per-user (a cleared tester sees the agent model, nobody
// else does), so it must never land in a shared cache. See getLayoutModels.
const MODELS_CACHE_HEADERS = { "Cache-Control": "private, max-age=60" };

export const GET: RequestHandler = async ({ locals }) => {
	return superjsonResponse(await getLayoutModels(locals), { headers: MODELS_CACHE_HEADERS });
};
