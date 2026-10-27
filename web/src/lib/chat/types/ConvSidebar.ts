import type { ObjectId } from "bson";
import type { TitleSource } from "$lib/chat/types/MessageUpdate";

export interface ConvSidebar {
	id: ObjectId | string;
	title: string;
	/** Which path in `textGeneration/title.ts` produced `title`, when this page watched it happen
	 *  (CUR-1819). Ephemeral by design, exactly like `title` itself: the server persists the text and
	 *  not the provenance, so this is absent on a fresh load and present only for a conversation
	 *  titled during this session. Rendered as `data-title-source` on the sidebar link. */
	titleSource?: TitleSource;
	updatedAt: Date;
	model?: string;
	avatarUrl?: string | Promise<string | undefined>;
}
