// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
export async function GET({ locals }) {
	if (locals.user) {
		const res = {
			id: locals.user._id,
			username: locals.user.username,
			name: locals.user.name,
			email: locals.user.email,
			avatarUrl: locals.user.avatarUrl,
			hfUserId: locals.user.hfUserId,
		};

		return Response.json(res);
	}
	return Response.json({ message: "Must be signed in" }, { status: 401 });
}
