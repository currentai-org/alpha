import { type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { collections } from "$lib/chat/server/database";
import { authCondition } from "$lib/chat/server/auth";
import { multimodalEnabled } from "$lib/chat/server/textOnly";
import { requireExportUser } from "$lib/chat/server/dataPortability";
import {
	custodialStorageConfigured,
	listCustodialFiles,
} from "$lib/chat/server/storage/custodialStorage";
import { userPrefix } from "$lib/chat/server/storage/custodialBucket";
import { storedAttachmentKey } from "$lib/chat/server/storage/attachmentsToCustodial";
import { logger } from "$lib/chat/server/logger";

// Counts of what the export ZIP would hold right now, gathered as ../+server.ts gathers it, so the
// account page can say it before anyone downloads (CUR-2395). A person deciding whether to leave
// should not have to unzip a file to learn whether their conversations, files and each answer's
// provenance made it in. Not rate-limited: it reads counts, not bytes.
export const GET: RequestHandler = async ({ locals }) => {
	const user = requireExportUser(locals.user);

	// Listed first: a chat attachment kept in Alpha storage is in the listing too, and the export
	// writes it once (CUR-3327).
	const accountId = user._id.toString();
	const stored = custodialStorageConfigured()
		? await listCustodialFiles(accountId).catch((err) => {
				logger.error({ err }, "[export-summary] could not list stored files");
				return [];
			})
		: [];
	const prefix = userPrefix(accountId);
	const storedKeys = new Set(stored.map((entry) => entry.path.slice(prefix.length)));

	const conversations = await collections.conversations
		.find({ ...authCondition(locals) })
		.toArray();
	let answers = 0;
	let files = stored.length;
	for (const conversation of conversations) {
		for (const message of conversation.messages) {
			if (message.from === "assistant") answers++;
			// The export route only writes attachments when multimodal is on; count the same way.
			if (!multimodalEnabled()) continue;
			for (const ref of message.files ?? []) {
				const key = storedAttachmentKey(conversation._id.toString(), ref);
				if (!key || !storedKeys.has(key)) files++;
			}
		}
	}

	return json({ conversations: conversations.length, answers, files });
};
