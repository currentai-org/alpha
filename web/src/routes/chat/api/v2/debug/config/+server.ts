// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { config } from "$lib/chat/server/config";
import { requireAdminPermission } from "$lib/chat/server/adminAuth";

// Same gate as every /chat/admin route: the signed-in account's role, here the admin role's
// config:read.
export const GET: RequestHandler = async ({ locals, cookies }) => {
	await requireAdminPermission({ cookies, locals }, { config: "read" });
	const { models } = await import("$lib/chat/server/models");
	return superjsonResponse({
		OPENAI_BASE_URL: config.OPENAI_BASE_URL,
		OPENAI_API_KEY_SET: Boolean(config.OPENAI_API_KEY || config.HF_TOKEN),
		LEGACY_HF_TOKEN_SET: Boolean(config.HF_TOKEN && !config.OPENAI_API_KEY),
		MODELS_COUNT: models.length,
		NODE_VERSION: process.versions.node,
	});
};
