// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { ObjectId } from "bson";
import type { Message } from "./Message";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

export interface Conversation extends Timestamps {
	_id: ObjectId;

	sessionId?: string;
	userId?: User["_id"];
	/** The workspace active when this conversation was created, or undefined outside one. */
	organizationId?: string;
	/** Stamped just before the workspace was deleted, which nulls organizationId. */
	formerWorkspaceId?: string;
	formerWorkspaceName?: string;
	/** The guest session this conversation belonged to before sign-in moved it to the account.
	 *  Attachments the move left under guests/<id>/ (over the account's quota, a failed copy, or a turn
	 *  sent before the background move landed) are read from there, since no table copy exists. */
	formerGuestSessionId?: string;
	/** Stamped when the Mila output guard flagged an answer here (flag `mila-sp-output-guard`). Every later
	 *  turn is refused (403) while it is set, whatever the flag says now. */
	crisisEndedAt?: Date;

	/** Heads the sidebar list. Absent on a chat that never was pinned. */
	pinned?: boolean;
	/** Out of the sidebar list and the default view, kept under Settings → Archived chats. */
	archived?: boolean;
	/** The ids of the person's tags on this chat (conversation_tags.id). Absent on a chat never tagged. */
	tags?: string[];

	model: string;

	title: string;
	rootMessageId?: Message["id"];
	messages: Message[];

	meta?: {
		fromShareId?: string;
		/** set on a conversation brought in from another chat app. `screened: false` means nothing
		 *  screened its messages (they carry no moderation verdict, which is not a screen that failed open);
		 *  `fingerprint` is what the source held when it was last imported, for a rerun to compare. */
		imported?: { source: "open-webui"; screened: false; fingerprint: string };
	};

	preprompt?: string;

	/** The title, sealed to the owner's history recipient: base64 of an age file opening to a
	 *  `SealedEnvelope` of kind "title" bound to this conversation's id. The browser reads it; while set,
	 *  `title` is not the title. Written on persist while the history-seal-writes flag is on. */
	sealedTitle?: string;
	/** The revision of `sealedTitle`; the envelope carries the same number (`SealedEnvelope.rev`). */
	sealedTitleRev?: number;
	/** The preprompt, sealed the same way (kind "preprompt"). */
	sealedPreprompt?: string;
	/** The revision of `sealedPreprompt`. */
	sealedPrepromptRev?: number;
	/** The server's HMAC of the preprompt at `sealedPrepromptRev`, which a turn's posted
	 *  preprompt must match. */
	sealedPrepromptMac?: string;

	/** The id an import brought this conversation in under (the Open WebUI chat id), absent
	 *  for one started in Alpha. Rows from the removed Thunderbolt sync carry its client's id. */
	syncClientId?: string;
	/** Where an imported conversation came from: `open-webui-import`, or a Thunderbolt sync
	 *  client's id on rows written before that sync was removed. */
	syncOrigin?: string;
}
