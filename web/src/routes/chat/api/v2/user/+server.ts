// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { getLayoutUser } from "$lib/chat/server/layoutData";

export const GET: RequestHandler = async ({ locals }) => {
	return superjsonResponse(getLayoutUser(locals));
};
