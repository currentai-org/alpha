import type { ObjectId } from "bson";
import type { Message } from "./Message";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

export interface Conversation extends Timestamps {
	_id: ObjectId;

	sessionId?: string;
	userId?: User["_id"];
	/** The workspace active when this conversation was created, or undefined outside one. (CUR-961) */
	organizationId?: string;
	/** Stamped just before the workspace was deleted, which nulls organizationId. (CUR-3040) */
	formerWorkspaceId?: string;
	formerWorkspaceName?: string;
	/** The guest session this conversation belonged to before sign-in moved it to the account.
	 *  Attachments the move left under guests/<id>/ (over the account's quota, a failed copy, or a turn (CUR-2183)
	 *  sent before the background move landed) are read from there, since no table copy exists. */
	formerGuestSessionId?: string;

	model: string;

	title: string;
	rootMessageId?: Message["id"];
	messages: Message[];

	meta?: {
		fromShareId?: string;
	};

	preprompt?: string;

	/** The id a sync client pushed this conversation under, absent for one started in Alpha. (CUR-4312) */
	syncClientId?: string;
	/** The OAuth client_id that created this conversation by sync. (CUR-4312) */
	syncOrigin?: string;
}
