import type { Session } from "./Session";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

export interface MessageEvent extends Pick<Timestamps, "createdAt"> {
	userId: User["_id"] | Session["sessionId"];
	// Keyed HMAC of the client IP (domain "rate-limit"), never the raw IP — see db/ipHash.ts.
	ipHash?: string;
	expiresAt: Date;
	// "globalDaily" = a row in the service-wide 24h request-cap window (see conversation/[id]/+server).
	// "conversationCreate" = one POST /chat/conversation, counted apart from turns (CUR-3529).
	// "chatAttachment" = one file attached in chat, counted against the 24h allowance (CUR-3235).
	// "sandboxRun" = one run-code sandbox call that ran, counted against the account's tier (CUR-4578).
	type:
		| "message"
		| "export"
		| "export-thunderbolt"
		| "globalDaily"
		| "conversationCreate"
		| "chatAttachment"
		| "sandboxRun";
	/** A chatAttachment row's size, so the allowance can bound bytes as well as files. */
	bytes?: number;
	/** A sandboxRun row's conversation, so the live-sandbox count can tell conversations apart. */
	conversationId?: string;
}
