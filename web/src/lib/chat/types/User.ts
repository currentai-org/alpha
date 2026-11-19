// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { ObjectId } from "bson";
import type { Timestamps } from "./Timestamps";

export interface User extends Timestamps {
	_id: ObjectId;

	username?: string;
	name: string;
	email?: string;
	avatarUrl: string | undefined;
	// Optional: Google/passkey/email-OTP users never touch Hugging Face at all.
	hfUserId?: string;
	// The Better Auth user.id this shadow row was created for — NOT derivable from `_id`,
	// which is a one-way sha256 hash of it. wipeUserData.ts needs this to find and delete the linked
	// Better Auth account/passkey/session/user rows, which are keyed by Better Auth's own id, not ours.
	betterAuthUserId?: string;
	isAdmin?: boolean;
	// Better Auth's verification bit for `email`, set per request from the session and never
	// stored on this row. Flag evaluation sends the email only when this is true (flagEmail.ts).
	emailVerified?: boolean;
	// Better Auth's admin-plugin role (operator, editor, admin; comma-joined when several),
	// set per request from the session like emailVerified and never stored on this row.
	role?: string;
	isEarlyAccess?: boolean;
}
