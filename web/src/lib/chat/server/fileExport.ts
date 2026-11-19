import { error, redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { authCondition } from "$lib/chat/server/auth";
import { collections } from "$lib/chat/server/database";
import { nextExportAt, type ExportEventType } from "$lib/chat/server/dataPortability";
import { logger } from "$lib/chat/server/logger";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { User } from "$lib/chat/types/User";

/** How long a single-file download (Thunderbolt, Open WebUI) waits before the next one. */
const FILE_EXPORT_WINDOW_MS = 10 * 60 * 1000;

/** What a single-file export route writes from the account's conversations. */
export interface FileExport {
	body: unknown;
	filename: string;
	/** Counts for the log line; never content. */
	counts: Record<string, number>;
}

/**
 * The body every single-file export route shares: one download per ten minutes,
 * then the account's conversations, written by `build` as one .json attachment. Inside the window a
 * click from the account page goes back there, which says when; any other request gets a 429. The
 * caller has already checked who may export and any gate of its own.
 */
export async function fileExportResponse(
	user: Pick<User, "_id">,
	locals: App.Locals,
	request: Request | undefined,
	type: Exclude<ExportEventType, "export">,
	build: (conversations: Conversation[], now: Date) => FileExport
): Promise<Response> {
	const now = new Date();
	if (await nextExportAt(user._id, now, type)) {
		if (request?.headers.get("sec-fetch-mode") === "navigate") redirect(303, `${base}/settings/account`);
		error(429, "You have already downloaded this file recently. Please wait 10 minutes before trying again.");
	}
	const conversations = await collections.conversations.find({ ...authCondition(locals) }).toArray();
	const file = build(conversations, now);
	await collections.messageEvents.insertOne({
		userId: user._id,
		type,
		createdAt: now,
		expiresAt: new Date(now.getTime() + FILE_EXPORT_WINDOW_MS),
	});
	logger.info({ userId: user._id, type, ...file.counts }, "Exported user data as a single file");
	return new Response(JSON.stringify(file.body), {
		headers: {
			"Content-Type": "application/json",
			"Content-Disposition": `attachment; filename="${file.filename}"`,
		},
	});
}
