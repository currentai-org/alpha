import { error, type RequestHandler } from "@sveltejs/kit";
import { requireExportUser, thunderboltExportEnabled } from "$lib/chat/server/dataPortability";
import { fileExportResponse } from "$lib/chat/server/fileExport";
import { exportedConversation } from "$lib/chat/server/exportFormat";
import { toThunderbolt } from "$lib/chat/server/thunderboltExport";

// The same conversations as the ZIP's conversations.json, written as a file Thunderbird's Thunderbolt
// imports under Settings → Preferences → Data → Import Data. A bare .json download rather
// than a file inside the ZIP, because Thunderbolt's picker accepts .json and nothing else.
//
// Nothing leaves Alpha but this download. The person carries the file to Thunderbolt, whose own app
// encrypts the rows before they sync, so no Thunderbolt key or session ever reaches our servers.
// Live sync would need Alpha enrolled as one of their devices, holding the account key that opens
// everything they keep there, which is why this route is a file and not a push.

export const GET: RequestHandler = async ({ locals, request }) => {
	const user = requireExportUser(locals.user);
	if (!thunderboltExportEnabled()) error(404, "Not found");
	return fileExportResponse(user, locals, request, "export-thunderbolt", (conversations, now) => {
		const envelope = toThunderbolt(
			conversations.map((c) => exportedConversation(c)),
			// Thunderbolt warns when this email differs from the account importing it, and reads nothing
			// else here. Our account id stays out, as it does in the ZIP.
			{ id: "", email: user.email ?? null },
			now
		);
		return {
			body: envelope,
			// Thunderbolt names its own exports this way; a person moving between the two sees one kind of file.
			filename: `thunderbolt-export-${envelope.exportedAt.slice(0, 10)}.json`,
			counts: { nConversations: envelope.tables.chat_threads.length, nMessages: envelope.tables.chat_messages.length },
		};
	});
};
