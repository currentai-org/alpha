// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { ObjectId } from "bson";
import type { TitleSource } from "$lib/chat/types/MessageUpdate";

export interface ConvSidebar {
	id: ObjectId | string;
	title: string;
	/** The title sealed to the owner's history key. While set, `title` is not the title:
	 *  NavConversationItem opens this in the browser and shows a locked label until it can. */
	sealedTitle?: string;
	/** The revision of `sealedTitle`, which its envelope must match. */
	sealedTitleRev?: number;
	/** Which path in `textGeneration/title.ts` produced `title`, when this page watched it happen.
	 *  Ephemeral by design, exactly like `title` itself: the server persists the text and
	 *  not the provenance, so this is absent on a fresh load and present only for a conversation
	 *  titled during this session. Rendered as `data-title-source` on the sidebar link. */
	titleSource?: TitleSource;
	updatedAt: Date;
	model?: string;
	/** Heads the sidebar, above the date groups. */
	pinned?: boolean;
	/** The ids of the person's tags on this chat, for the row menu's Tags dialog. */
	tags?: string[];
	avatarUrl?: string | Promise<string | undefined>;
}
