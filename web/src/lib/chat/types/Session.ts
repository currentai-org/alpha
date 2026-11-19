// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { ObjectId } from "bson";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

export interface Session extends Timestamps {
	_id: ObjectId;
	sessionId: string;
	userId: User["_id"];
	userAgent?: string;
	// No `ip` field: the legacy session row never had a reader for it, and the notice says raw IPs
	// are not kept outside the active-sign-in list Better Auth's own `session` table backs.
	expiresAt: Date;
	admin?: boolean;
	coupledCookieHash?: string;

	oauth?: {
		token: {
			value: string;
			expiresAt: Date;
		};
		refreshToken?: string;
	};
}
