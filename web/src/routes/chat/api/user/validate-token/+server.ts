// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { adminTokenManager } from "$lib/chat/server/adminToken";
import {
	adminTokenAllowed,
	recordAdminTokenFailure,
	clearAdminTokenFailures,
} from "$lib/chat/server/db/adminTokenRate";
import { z } from "zod";

const validateTokenSchema = z.object({
	token: z.string(),
});

// brute-force lockout — this endpoint had no throttle at all before. Low real urgency
// (ADMIN_CLI_LOGIN must stay `false` in prod by standing convention), but a token check deserves one.
export const POST = async ({ request, locals, getClientAddress }) => {
	const { success, data } = validateTokenSchema.safeParse(await request.json());

	if (!success) {
		return new Response(JSON.stringify({ error: "Invalid token" }), { status: 400 });
	}

	const ip = getClientAddress();
	if (!(await adminTokenAllowed(ip))) {
		return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), {
			status: 429,
		});
	}

	if (await adminTokenManager.checkToken(data.token, locals.sessionId)) {
		await clearAdminTokenFailures(ip);
		return new Response(JSON.stringify({ valid: true }));
	}

	await recordAdminTokenFailure(ip);
	return new Response(JSON.stringify({ valid: false }));
};
