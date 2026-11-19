// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { applySettingsUpdate } from "$lib/chat/server/api/utils/applySettingsUpdate";

export async function POST({ request, locals }) {
	await applySettingsUpdate(locals, await request.json());
	return new Response();
}
