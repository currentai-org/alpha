import { error, redirect, type RequestHandler } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { collections } from "$lib/chat/server/database";
import { authCondition } from "$lib/chat/server/auth";
import { nextExportAt, requireExportUser, thunderboltExportEnabled } from "$lib/chat/server/dataPortability";
import { exportedConversation } from "$lib/chat/server/exportFormat";
import { toThunderbolt } from "$lib/chat/server/thunderboltExport";
import { logger } from "$lib/chat/server/logger";

// The same conversations as the ZIP's conversations.json, written as a file Thunderbird's Thunderbolt
// imports under Settings → Preferences → Data → Import Data (CUR-2407). A bare .json download rather
// than a file inside the ZIP, because Thunderbolt's picker accepts .json and nothing else.
//
// Nothing leaves Alpha but this download. The person carries the file to Thunderbolt, whose own app
// encrypts the rows before they sync, so no Thunderbolt key or session ever reaches our servers.
// Live sync would need Alpha enrolled as one of their devices, holding the account key that opens
// everything they keep there (CUR-2409), which is why this route is a file and not a push.

export const GET: RequestHandler = async ({ locals, request }) => {
	const user = requireExportUser(locals.user);
	if (!thunderboltExportEnabled()) error(404, "Not found");

	if (await nextExportAt(user._id, new Date(), "export-thunderbolt")) {
		if (request?.headers.get("sec-fetch-mode") === "navigate") {
			redirect(303, `${base}/settings/account`);
		}
		error(429, "You have already downloaded this file recently. Please wait 10 minutes before trying again.");
	}

	const conversations = await collections.conversations.find({ ...authCondition(locals) }).toArray();
	const envelope = toThunderbolt(
		conversations.map((c) => exportedConversation(c)),
		// Thunderbolt warns when this email differs from the account importing it, and reads nothing
		// else here. Our account id stays out, as it does in the ZIP (CUR-1836).
		{ id: "", email: user.email ?? null }
	);

	await collections.messageEvents.insertOne({
		userId: user._id,
		type: "export-thunderbolt",
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 1000 * 60 * 10),
	});
	logger.info(
		{ userId: user._id, nConversations: envelope.tables.chat_threads.length, nMessages: envelope.tables.chat_messages.length },
		"Exported user data for Thunderbolt"
	);

	// Thunderbolt names its own exports this way; a person moving between the two sees one kind of file.
	const day = envelope.exportedAt.slice(0, 10);
	return new Response(JSON.stringify(envelope), {
		headers: {
			"Content-Type": "application/json",
			"Content-Disposition": `attachment; filename="thunderbolt-export-${day}.json"`,
		},
	});
};
