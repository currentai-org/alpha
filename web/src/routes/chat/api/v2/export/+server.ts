import { error, redirect, type RequestHandler } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { collections } from "$lib/chat/server/database";
import { authCondition } from "$lib/chat/server/auth";
import yazl from "yazl";
import { downloadFile } from "$lib/chat/server/files/downloadFile";
import { multimodalEnabled } from "$lib/chat/server/textOnly";
import { nextExportAt, requireExportUser } from "$lib/chat/server/dataPortability";
import {
	conversationMarkdown,
	exportedConversation,
	readableName,
	exportEnvelope,
	readme,
} from "$lib/chat/server/exportFormat";
import {
	custodialStorageConfigured,
	downloadCustodialFile,
	listCustodialFiles,
} from "$lib/chat/server/storage/custodialStorage";
import { userPrefix } from "$lib/chat/server/storage/custodialBucket";
import { storedAttachmentKey } from "$lib/chat/server/storage/attachmentsToCustodial";
import mimeTypes from "mime-types";
import { logger } from "$lib/chat/server/logger";
import { humanEvalExport } from "$lib/chat/server/db/humanEval";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";

// The ZIP is written for the person who asked for it (CUR-1836): README.md, one readable markdown
// file per conversation with each answer's provenance, the files they stored with us, and a JSON
// copy built from named fields. exportFormat.ts decides what each file says; this route gathers the
// records and the bytes.

export const GET: RequestHandler = async ({ locals, request }) => {
	const user = requireExportUser(locals.user);

	if (await nextExportAt(user._id)) {
		// The Account page's Download is a plain link, so a page loaded before an export from another
		// tab still offers it, and a 429 here would replace that page with a bare error (CUR-3849).
		// Sent back instead, the page reads the hour from the server and says it in the row.
		if (request?.headers.get("sec-fetch-mode") === "navigate") {
			redirect(303, `${base}/settings/account`);
		}
		error(
			429,
			"You have already exported your data recently. Please wait 1 hour before exporting again."
		);
	}

	const accountId = user._id.toString();
	const stats = { nConversations: 0, nMessages: 0, nFiles: 0, nStoredFiles: 0, nStoredSkipped: 0 };
	const zipfile = new yazl.ZipFile();

	// The files the person stored with us are theirs whether or not the storage view is on for them
	// today, the same reasoning wipeCustodialFiles gives for deletion. Listed before the conversations
	// because a chat attachment kept in Alpha storage is in this listing too: it goes in once, under
	// files/, and its conversation points there (CUR-3327).
	const prefix = userPrefix(accountId);
	let stored: { path: string }[] = [];
	if (custodialStorageConfigured()) {
		// `storage_listing_down` (preview only, see faultInjection.ts) fails the listing here,
		// so a spec can open the ZIP this branch produces. (CUR-2798)
		const listingDown = (await resolveFaultInjection(request)) === "storage_listing_down";
		const listing = listingDown
			? Promise.reject(new Error("fault injection: storage_listing_down"))
			: listCustodialFiles(accountId);
		const entries = await listing.catch((err) => {
			logger.error({ err }, "[export] could not list stored files");
			return null;
		});
		if (entries === null) stats.nStoredSkipped = -1;
		stored = entries ?? [];
	}
	const storedKeys = new Set(stored.map((entry) => entry.path.slice(prefix.length)));

	const conversations = await collections.conversations.find({ ...authCondition(locals) }).toArray();
	const exported = [];
	for (const conversation of conversations) {
		stats.nConversations++;
		stats.nMessages += conversation.messages.length;

		// TEXT-ONLY ALPHA: never fetch attachment blobs for export (a download path); keeps export
		// text-only even for pre-existing/crafted file refs. Gated; see textOnly.
		const filesByMessage = new Map<string, string[]>();
		if (multimodalEnabled()) {
			for (const message of conversation.messages) {
				for (const ref of message.files ?? []) {
					const key = storedAttachmentKey(conversation._id.toString(), ref);
					if (key && storedKeys.has(key)) {
						filesByMessage.set(message.id, [...(filesByMessage.get(message.id) ?? []), `files/${key}`]);
						continue;
					}
					const file = await downloadFile(ref.value, conversation._id, {
						ownerId: conversation.userId?.toString(),
						// A guest's files the sign-in move left behind are still under guests/ (CUR-2183).
						guestSessionId: conversation.userId ? conversation.formerGuestSessionId : conversation.sessionId,
						name: ref.name,
						mime: ref.mime,
						location: ref.location,
					}).catch(() => null);
					if (!file) continue;
					const extension = mimeTypes.extension(file.mime) || null;
					const name =
						`attachments/${conversation._id.toString()}-${file.name.split("-")[1]?.slice(0, 8) ?? "file"}` +
						(extension ? `.${extension}` : "");
					zipfile.addBuffer(Buffer.from(file.value, "base64"), name);
					filesByMessage.set(message.id, [...(filesByMessage.get(message.id) ?? []), name]);
					stats.nFiles++;
				}
			}
		}

		zipfile.addBuffer(Buffer.from(conversationMarkdown(conversation, filesByMessage)), readableName(conversation));
		exported.push(exportedConversation(conversation, filesByMessage));
	}
	zipfile.addBuffer(Buffer.from(JSON.stringify(exportEnvelope(accountId, exported), null, 2)), "conversations.json");

	// One unreadable file is named in the README rather than failing the whole export.
	for (const entry of stored) {
		const blob = await downloadCustodialFile(accountId, entry.path).catch(() => null);
		if (!blob) {
			stats.nStoredSkipped++;
			continue;
		}
		zipfile.addBuffer(Buffer.from(await blob.arrayBuffer()), `files/${entry.path.slice(prefix.length)}`);
		stats.nStoredFiles++;
	}

	const humanEval = await humanEvalExport(accountId);
	// A rating needs a profile, so a person with no profile has nothing here.
	if (humanEval.profiles.length) {
		zipfile.addBuffer(Buffer.from(JSON.stringify(humanEval, null, 2)), "human-evaluation.json");
	}

	zipfile.addBuffer(
		Buffer.from(
			readme({
				conversations: stats.nConversations,
				humanEvalRatings: humanEval.profiles.length ? humanEval.ratings.length : undefined,
				files: stats.nStoredFiles,
				filesSkipped: Math.max(stats.nStoredSkipped, 0),
				listingFailed: stats.nStoredSkipped < 0,
			})
		),
		"README.md"
	);

	logger.info({ userId: user._id, ...stats }, "Exported user data");
	zipfile.end();
	await collections.messageEvents.insertOne({
		userId: user._id,
		type: "export",
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1 hour
	});

	// @ts-expect-error - zipfile.outputStream is not typed correctly
	return new Response(zipfile.outputStream, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": 'attachment; filename="aipotluck-export.zip"',
		},
	});
};
