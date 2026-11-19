import type { RequestHandler } from "@sveltejs/kit";
import { requireExportUser } from "$lib/chat/server/dataPortability";
import { fileExportResponse } from "$lib/chat/server/fileExport";
import { toOpenWebUiChat } from "$lib/chat/server/openWebUiImport/chatFile";

// Every conversation as the file Open WebUI's Settings → Data Controls → Import chats reads,
// so a person who moved from Open WebUI can move back, and `pnpm import:open-webui <file> --as <email>`
// brings it into another Alpha. Archived and pinned conversations travel with that state, and every
// branch a retry or an edit made travels too. Open WebUI's own export is a bare .json, and so is this.

export const GET: RequestHandler = async ({ locals, request }) =>
	fileExportResponse(requireExportUser(locals.user), locals, request, "export-open-webui", (conversations, now) => {
		const chats = conversations.map((c) => toOpenWebUiChat(c, now));
		return {
			body: chats,
			// Open WebUI names its own exports this way; a person moving between the two sees one kind of file.
			filename: `chat-export-${now.getTime()}.json`,
			counts: { nConversations: chats.length, nMessages: chats.reduce((n, c) => n + Object.keys(c.chat.history.messages).length, 0) },
		};
	});
