// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { Session } from "./Session";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

export interface MessageEvent extends Pick<Timestamps, "createdAt"> {
	userId: User["_id"] | Session["sessionId"];
	// Keyed HMAC of the client IP (domain "rate-limit"), never the raw IP — see db/ipHash.ts.
	ipHash?: string;
	expiresAt: Date;
	// "globalDaily" = a row in the service-wide 24h request-cap window (see conversation/[id]/+server).
	// "conversationCreate" = one POST /chat/conversation, counted apart from turns.
	// "chatAttachment" = one file attached in chat, counted against the 24h allowance.
	// "sandboxRun" = one run-code sandbox call that ran, counted against the account's tier.
	// "localEndpointCreate" / "localEndpointStatus" = one create or status check of a local inference
	// endpoint, counted against that account's own budget.
	type:
		| "message"
		| "export"
		| "export-thunderbolt"
		| "export-open-webui"
		| "globalDaily"
		| "conversationCreate"
		| "chatAttachment"
		| "sandboxRun"
		| "localEndpointCreate"
		| "localEndpointStatus";
	/** A chatAttachment row's size, so the allowance can bound bytes as well as files. */
	bytes?: number;
	/** A sandboxRun row's conversation, so the live-sandbox count can tell conversations apart. */
	conversationId?: string;
}
