// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { base } from "$lib/chat/paths";
import { collections } from "$lib/chat/server/database";
import { redirect } from "@sveltejs/kit";
import { sameSite, secure, sessionCookieName } from "$lib/chat/server/auth";
import { ADMIN_PROOF_COOKIE } from "$lib/chat/server/adminToken";

export async function POST({ locals, cookies }) {
	await collections.sessions.deleteOne({ sessionId: locals.sessionId });

	cookies.delete(sessionCookieName, {
		path: "/",
		// So that it works inside the space's iframe
		sameSite,
		secure,
		httpOnly: true,
	});
	// Drop the durable admin grant too, so logout fully de-escalates.
	cookies.delete(ADMIN_PROOF_COOKIE, { path: "/", sameSite, secure, httpOnly: true });
	return redirect(302, `${base}/`);
}
