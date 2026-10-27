import { error } from "@sveltejs/kit";
import { z } from "zod";
import { fileTypeFromBuffer } from "file-type";
import { chatRequestSchema, type ChatRequestPayload } from "$lib/chat/server/chat/requestSchema";
import {
	CHAT_ATTACHMENTS_MAX_BYTES,
	CHAT_ATTACHMENTS_MAX_COUNT,
	chatAttachmentsTooLargeMessage,
	chatAttachmentsTooManyMessage,
	myFilesFullMessage,
	attachmentAllowanceMessage,
	SIGN_IN_TO_ATTACH_MESSAGE,
	SIGN_IN_TO_USE_AGENT_MESSAGE,
} from "$lib/chat/constants/uploadLimits";
import {
	attachmentAllowanceEnforced,
	attachmentAllowanceLeft,
	fitsAllowance,
	recordAttachments,
	type AttachmentOwner,
} from "$lib/chat/server/db/attachmentAllowance";
import { multimodalEnabled } from "$lib/chat/server/textOnly";
import { loginEnabled } from "$lib/chat/server/oidcConfig";
import { deployEnv } from "$lib/chat/server/deployEnv";
import { CLIPBOARD_MIME } from "$lib/chat/constants/mime";
import { linkedAttachmentLocation, storeChatAttachments } from "$lib/chat/server/storage/attachmentsToCustodial";
import { StorageQuotaExceededError } from "$lib/chat/server/storage/custodialStorage";
import { flagEmail } from "$lib/chat/server/flagEmail";
import { runInBackground } from "$lib/chat/server/vercelBackground";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import { usageLimits } from "$lib/chat/server/usageLimits";
import {
	csamScanConfigured,
	HmaUnreachableError,
	UPLOAD_NOT_SCANNED_MESSAGE,
	type CsamScanResult,
} from "$lib/chat/server/storage/csamScan";
import { documentAttachmentsEnabled, documentTextOnlyEnabled } from "$lib/chat/server/documentAttachmentsGate";
import { DOCUMENT_TEXT_UNREADABLE_MESSAGE, documentAsText } from "$lib/chat/server/storage/documentTextOnly";
import {
	DOCUMENTS_NOT_ACCEPTED_MESSAGE,
	scanFileForCsam,
	scanTargetForMime,
	UnscannableFileError,
	UNSCANNABLE_FILE_MESSAGE,
} from "$lib/chat/server/storage/embeddedImageScan";
import { acceptedAttachmentType, FILE_TYPE_NOT_ACCEPTED_MESSAGE } from "$lib/chat/server/chat/attachmentType";
import { logger } from "$lib/chat/server/logger";
import { hashIp } from "$lib/chat/server/db/ipHash";
import { recordCsamMatch } from "$lib/chat/server/alerting";
import { reportCsamMatchToCoop } from "$lib/chat/server/moderation";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import { messageTooLongMessage } from "$lib/chat/utils/messageTooLong";

/** The typed inputs a chat turn needs, parsed out of the multipart POST body. MCP selection and
 *  timezone are not returned — they are attached to `locals` as forward-looking pipeline context
 *  (see below). */
export interface ParsedChatRequest {
	newPrompt: ChatRequestPayload["inputs"];
	messageId: ChatRequestPayload["id"];
	isRetry: ChatRequestPayload["is_retry"];
	agentAttach: ChatRequestPayload["agent_attach"];
	generationId: ChatRequestPayload["generationId"];
	newMessageIds: ChatRequestPayload["newMessageIds"];
	searchContext: ChatRequestPayload["searchContext"];
	/** Never absent: a request with no mode is resolved to "off" here, once, so the persona, the classic
	 *  search plan and the native path all read the same value (CUR-3293). */
	webSearchMode: NonNullable<ChatRequestPayload["webSearchMode"]>;
	speakAll: ChatRequestPayload["speakAll"];
	speakMode: ChatRequestPayload["speakMode"];
	agentMode: ChatRequestPayload["agentMode"];
	autoRoute: ChatRequestPayload["autoRoute"];
	uploadedFiles: NonNullable<Message["files"]>;
	/** Set when this turn's files were refused because they could not be scanned (CUR-2382). */
	attachmentNotice?: string;
	/** The files this turn left out, by name, so the sent message can still show them (CUR-3405). */
	leftOutFiles: NonNullable<Message["leftOutFiles"]>;
}

/** Whose attachment allowance a conversation's files count against, or undefined with no identity. A
 *  guest is also counted by network (CUR-3600). */
function attachmentOwner(
	conv: { userId?: { toString(): string }; sessionId?: string },
	clientAddress: string | undefined
): AttachmentOwner | undefined {
	const userId = conv.userId?.toString();
	if (userId) return { userId };
	if (!conv.sessionId) return undefined;
	const ipHash = clientAddress ? (hashIp(clientAddress, "rate-limit") ?? undefined) : undefined;
	return { guestSessionId: conv.sessionId, ...(ipHash ? { ipHash } : {}) };
}

/**
 * Parse and validate the multipart chat POST: the JSON `data` field (via chatRequestSchema) plus
 * the attached files, returning the typed inputs the rest of the turn consumes. Side effects, in
 * the exact order the inline handler ran them so error precedence is preserved:
 *   - 400 if `data` is missing/non-string, then schema validation;
 *   - attaches the per-turn MCP selection + timezone to `locals` (forward-looking, see note below);
 *   - 413 if the message carries more than CHAT_ATTACHMENTS_MAX_COUNT files, pastes included (CUR-3530);
 *   - 415 if an attachment is present while the text-only alpha gate is closed;
 *   - 400 if the prompt exceeds the configured message-length limit;
 *   - 413 if a base64 upload exceeds the shared file-size cap;
 *   - 422 if an image attachment matches a known CSAM hash — the whole request is refused, nothing
 *     is uploaded (CUR-986). With no scanner configured, or one that does not answer, the files are
 *     dropped and the text still answered, with `attachmentNotice` set (CUR-2382);
 *   - stores base64 files (hash refs pass through untouched): in the bucket where
 *     `custodial-storage-view` selects the owner, else in the files table. A throttled or stalled
 *     bucket, or a guest's full quota, sends the file to the files table and the turn goes on (CUR-2183,
 *     `storeChatAttachments`). A signed-in person's full quota answers 413 (CUR-3235).
 */
export async function parseChatRequest(opts: {
	request: Request;
	conv: Conversation;
	locals: App.Locals;
	/** The caller's address, so a guest's attachments also count against their network (CUR-3600). */
	clientAddress?: string;
}): Promise<ParsedChatRequest> {
	const { request, conv, locals } = opts;

	const form = await request.formData();

	const json = form.get("data");

	if (!json || typeof json !== "string") {
		error(400, "Invalid request");
	}

	const {
		inputs: newPrompt,
		speakAll,
		speakMode,
		id: messageId,
		is_retry: isRetry,
		agent_attach: agentAttach,
		generationId,
		newMessageIds,
		selectedMcpServerNames,
		selectedMcpServers,
		timezone,
		searchContext,
		webSearchMode,
		agentMode,
		autoRoute,
	} = chatRequestSchema.parse(JSON.parse(json));

	// Agent mode is for signed-in accounts (CUR-4400). The composer never offers it to a guest, so this
	// holds the line for a request that asks anyway: an explicit "on", or a re-attach to an agent task.
	// "auto" is left to agentModeEnabledForUser, which routes a guest's turn to chat.
	if (!locals.user && (agentMode === "on" || agentAttach)) {
		error(403, SIGN_IN_TO_USE_AGENT_MESSAGE);
	}

	// Attach MCP selection to locals so the text generation pipeline can consume it.
	// FORWARD-LOOKING: nothing reads locals.mcp yet — MCP tools are gated off for the alpha.
	// The read side (thread this into maybeRunMcpTool, see $lib/chat/server/mcp) lands when tools
	// re-enable, post-alpha. Kept wired so re-enabling is
	// a read-side change only.
	try {
		locals.mcp = {
			selectedServerNames: selectedMcpServerNames,
			selectedServers: (selectedMcpServers ?? []).map((s) => ({
				name: s.name,
				url: s.url,
				headers:
					s.headers && s.headers.length > 0
						? Object.fromEntries(s.headers.map((h) => [h.key, h.value]))
						: undefined,
			})),
		};
	} catch {
		// ignore attachment errors, pipeline will just use env servers
	}

	// Attach user timezone so the tool prompt can include localized time. Same status as
	// locals.mcp above: forward-looking, consumed when MCP tools re-enable post-alpha.
	if (timezone) {
		locals.timezone = timezone;
	}

	const fileParts = form
		.getAll("files")
		.filter((entry): entry is File => entry instanceof File && entry.size > 0);
	// Counted before any part is read, sniffed, scanned or stored. Pastes count too: the byte
	// cap below leaves them out, so this is the only bound on how many writes one request asks for. (CUR-3530)
	if (fileParts.length > CHAT_ATTACHMENTS_MAX_COUNT) {
		error(413, chatAttachmentsTooManyMessage());
	}
	const inputFiles = await Promise.all(
		fileParts.map(async (file) => {
				const [type, ...name] = file.name.split(";");

				return {
					type: z.literal("base64").or(z.literal("hash")).parse(type),
					value: await file.text(),
					mime: file.type,
					name: name.join(";"),
				};
			})
	);

	// Reject any attachment server-side when the multimodal gate is shut. The UI hides upload, but
	// enforce it here too so a crafted request can't slip a file/image through — a rejection that fires
	// is a check that can go red, where a capability flag that is merely false is not. Gated, not
	// removed. See $lib/chat/server/multimodalMode (CUR-159).
	//
	// A long paste is not an attachment (CUR-1895). The composer turns a paste of 3,984+ characters into
	// a clipboard-typed file so the message box stays usable, and prepareTurnMedia inlines it back into
	// the prompt as text, through the same guard screen and size cap as anything else. Counting it here
	// would fail every send after a long paste where this gate is shut. Only a fresh base64
	// paste is exempt: a hash reference points at stored bytes, and stays behind the gate. The declared
	// mime is the client's word, and uploadFile stores by sniffed type (see CUR-1449 below), so the
	// exemption also requires bytes with no binary signature — an image relabelled as a paste still 415s.
	const isTextPaste = async (f: (typeof inputFiles)[number]) =>
		f.type === "base64" &&
		f.mime === CLIPBOARD_MIME &&
		(await fileTypeFromBuffer(Buffer.from(f.value, "base64"))) === undefined;
	const pasteFlags = await Promise.all(inputFiles.map(isTextPaste));
	const attachments = inputFiles.filter((_, i) => !pasteFlags[i]);
	if (!multimodalEnabled() && attachments.length > 0) {
		error(415, "Attachments are disabled on this deployment.");
	}
	// Guests cannot attach files. Where sign-in is offered, a visitor without an account is
	// asked to sign in first; the composer offers sign-in instead of the picker, and this holds the line
	// for a request that skips it. A preview or production deployment refuses a guest's file even with sign-in
	// off (CUR-4400); only local dev and CI, which have no sign-in, stay open.
	const deployed = deployEnv() === "preview" || deployEnv() === "production";
	if (attachments.length > 0 && !locals.user && (loginEnabled() || deployed)) {
		error(403, SIGN_IN_TO_ATTACH_MESSAGE);
	}

	if (usageLimits?.messageLength && (newPrompt?.length ?? 0) > usageLimits.messageLength) {
		error(400, messageTooLongMessage(newPrompt?.length ?? 0, usageLimits.messageLength));
	}

	// each file is either:
	// base64 string requiring upload to the server
	// hash pointing to an existing file
	// A hash reference names a file this conversation already stored. Where it lives (CUR-2930) is
	// taken from the conversation's own copy of the reference, never from the request.
	const storedLocations = new Map(
		(conv.messages ?? []).flatMap((m) => m.files ?? []).flatMap((f) => (f.location ? [[f.value, f.location] as const] : []))
	);
	const hashFiles: NonNullable<Message["files"]> =
		inputFiles
			?.filter((file) => file.type === "hash")
			.map((file) => {
				const location = storedLocations.get(file.value);
				return location ? { ...file, location } : file;
			}) ?? [];
	// A long paste rides along as message text (CUR-1895 above), so it is never refused below.
	const b64Inputs = inputFiles
		.map((file, i) => ({ file, isPaste: pasteFlags[i] }))
		.filter(({ file }) => file.type !== "hash");
	let b64Files = b64Inputs.map(({ file }) => {
		const blob = Buffer.from(file.value, "base64");
		return new File([blob], file.name, { type: file.mime });
	});
	const refusable = b64Inputs.map(({ isPaste }) => !isPaste);

	// The cap is on the message's attachments together, because they share one request body
	// (see $lib/chat/constants/uploadLimits). A paste rides as message text and is not counted here. (CUR-2631)
	const attachedBytes = b64Files.reduce((sum, file, i) => (refusable[i] ? sum + file.size : sum), 0);
	if (attachedBytes > CHAT_ATTACHMENTS_MAX_BYTES) {
		error(413, chatAttachmentsTooLargeMessage());
	}

	// Scan every image attachment for a known-CSAM hash match before any of them reaches
	// uploadFile — refuse the whole request rather than storing a file and rejecting it later.
	// (CUR-986)
	// `file.type` here is the CLIENT-DECLARED part Content-Type (set as `mime: file.type`
	// above). Trusting it to pick what gets scanned would let a request label an image
	// `application/octet-stream` and skip scanCsamHash entirely, while uploadFile.ts stores it as an
	// image anyway, because that path sniffs the real bytes with fileTypeFromBuffer instead of
	// trusting the header. Sniff here too, so the same real type decides both scan-selection and
	// storage; a type fileTypeFromBuffer can't identify (e.g. plain text) falls back to the declared
	// one, same as uploadFile.ts's own fallback. (CUR-1449)
	const b64FileTypes = await Promise.all(
		b64Files.map(async (file) => (await fileTypeFromBuffer(await file.arrayBuffer()))?.mime ?? file.type)
	);
	//
	// CUR-2382, fail closed: no file is accepted unless it could be scanned. With no scanner configured
	// (the composer offers no attach control then, so only a crafted request gets here) or one that
	// does not answer, every file in the turn is dropped rather than stored, the text of the turn is
	// still answered, and `attachmentNotice` tells the person why. Text files cannot be PDQ-hashed, so
	// they are refused on configuration alone: the scanner has nothing to say about them.
	let attachmentNotice: string | undefined;
	// By file, not by index: files leave b64Files below, which would shift every later index.
	const sniffedType = new Map(b64Files.map((file, i) => [file, b64FileTypes[i]]));
	// Named before each drop below, while the file is still in b64Files, so none is listed twice.
	const leftOutFiles: NonNullable<Message["leftOutFiles"]> = [];
	const leaveOut = (dropped: (file: File) => boolean) => {
		for (const file of b64Files.filter(dropped)) {
			leftOutFiles.push({ name: file.name, mime: sniffedType.get(file) ?? file.type });
		}
	};
	const refusableFiles = new Set(b64Files.filter((_file, i) => refusable[i]));
	const dropUnscannedFiles = () => {
		leaveOut((file) => refusableFiles.has(file));
		b64Files = b64Files.filter((file) => !refusableFiles.has(file));
		attachmentNotice = UPLOAD_NOT_SCANNED_MESSAGE;
	};
	// A type the composer never offers (a 7z, a program, a spreadsheet) is dropped here with
	// its own line. Past this point it would be stored with no scan, since nothing can check it. A kept
	// text file is relabelled with its bare type, which the prompt's document wrapper prints unescaped. (CUR-3832)
	const relabelled = new Map<File, File>();
	const notAccepted = new Set<File>();
	for (const file of b64Files) {
		const accepted = acceptedAttachmentType(sniffedType.get(file) ?? file.type);
		if (accepted === null) notAccepted.add(file);
		else if (accepted !== file.type && file.type !== CLIPBOARD_MIME) {
			const kept = new File([file], file.name, { type: accepted });
			relabelled.set(file, kept);
			sniffedType.set(kept, accepted);
			if (refusableFiles.has(file)) refusableFiles.add(kept);
		}
	}
	if (notAccepted.size) {
		leaveOut((file) => notAccepted.has(file));
		b64Files = b64Files.filter((file) => !notAccepted.has(file));
		attachmentNotice = FILE_TYPE_NOT_ACCEPTED_MESSAGE;
	}
	b64Files = b64Files.map((file) => relabelled.get(file) ?? file);
	// A PDF or DOCX is opened only where `document-attachments` selects the account: its pictures are
	// extracted in-process (CUR-2780 tracks the sandboxed parser). Elsewhere it is
	// dropped unopened, never stored unscanned.
	const documentsAllowed = documentAttachmentsEnabled();
	const unopenedDocuments = new Set(
		b64Files.filter((file) => {
			const target = scanTargetForMime(sniffedType.get(file) ?? file.type);
			return !documentsAllowed && (target === "pdf" || target === "office");
		})
	);
	// `document-text-only`: such a document is read for its text instead, and only that text is kept.
	// Its bytes and pictures go no further than this function (storage/documentTextOnly.ts).
	if (unopenedDocuments.size && documentTextOnlyEnabled()) {
		const asText = new Map<File, File>();
		for (const file of unopenedDocuments) {
			const result = await documentAsText(file, sniffedType.get(file) ?? file.type);
			if (result.status === "text") {
				asText.set(file, result.file);
				sniffedType.set(result.file, "text/plain");
				if (refusableFiles.has(file)) refusableFiles.add(result.file);
				unopenedDocuments.delete(file);
			} else {
				attachmentNotice =
					result.status === "unreadable" ? DOCUMENT_TEXT_UNREADABLE_MESSAGE : DOCUMENTS_NOT_ACCEPTED_MESSAGE;
			}
		}
		b64Files = b64Files.map((file) => asText.get(file) ?? file);
	}
	if (unopenedDocuments.size) {
		leaveOut((file) => unopenedDocuments.has(file));
		b64Files = b64Files.filter((file) => !unopenedDocuments.has(file));
		attachmentNotice ??= DOCUMENTS_NOT_ACCEPTED_MESSAGE;
	}
	// Every file that can hold a picture is scanned, a PDF or DOCX by each image inside it,
	// so a picture cannot reach the model or storage by arriving in a document. (CUR-987)
	const scanned = b64Files
		.map((file) => ({ file, target: scanTargetForMime(sniffedType.get(file) ?? file.type) }))
		.filter(({ target }) => target !== null);
	let scans: CsamScanResult[] = [];
	if (refusable.some(Boolean) && !csamScanConfigured()) {
		logger.error(
			{ conversationId: conv._id.toString(), files: refusable.filter(Boolean).length },
			"[csam-scan] CSAM_SCAN_BASE_URL is unset, so this turn's attachments were refused (config error: the attach control should not have been offered)"
		);
		dropUnscannedFiles();
	} else {
		try {
			// The `csam_scanner_down` fault (preview only) fails this scan as an unreachable HMA does, so a
			// spec can read what a person sees in chat when the scanner is down, as My files already can.
			if (scanned.length && (await resolveFaultInjection(request)) === "csam_scanner_down") {
				throw new HmaUnreachableError(new Error("fault injection: csam_scanner_down"));
			}
			// A file we cannot check (an image this server cannot decode) is dropped alone, with its own
			// line; the scanner being down still drops every file below.
			const unscannable = new Map<File, string>();
			const results = await Promise.all(
				scanned.map(({ file, target }) =>
					scanFileForCsam(file, file.name, target).catch((e) => {
						if (!(e instanceof UnscannableFileError)) throw e;
						unscannable.set(file, e.notice);
						return { status: "clean" as const };
					})
				)
			);
			scans = results;
			if (unscannable.size) {
				leaveOut((file) => unscannable.has(file));
				b64Files = b64Files.filter((file) => !unscannable.has(file));
				attachmentNotice = unscannable.values().next().value ?? UNSCANNABLE_FILE_MESSAGE;
			}
		} catch (e) {
			if (!(e instanceof HmaUnreachableError)) throw e;
			logger.warn(
				{ conversationId: conv._id.toString(), err: e.message },
				"[csam-scan] scanner unreachable, so this turn's attachments were refused and the text answered"
			);
			dropUnscannedFiles();
		}
	}
	const csamMatch = scans.find((s) => s.status === "match");
	if (csamMatch?.status === "match") {
		// In runInBackground, not a bare `void`: the 422 below returns the response, and on Vercel a
		// floating promise freezes with it, so the alert post and the Coop report never leave (CUR-2382).
		void runInBackground(
			Promise.all([
				recordCsamMatch(
					conv.userId?.toString() ?? conv.sessionId ?? conv._id.toString(),
					{
						bankName: csamMatch.bankName,
						bankContentId: csamMatch.bankContentId,
						distance: csamMatch.distance,
					},
					"refused"
				),
				// No message id: the request is refused before appendTurnMessages ever runs, so the
				// conversation id is the one real, already-persisted thing to report against.
				reportCsamMatchToCoop({
					reportedItemId: conv._id.toString(),
					bankName: csamMatch.bankName,
					bankContentId: csamMatch.bankContentId,
					distance: csamMatch.distance,
				}),
			])
		);
		// No reason, on purpose, but a next step: the client drops the file on a 422, so the rest
		// of the message can go as it is. (CUR-3086)
		error(422, "This file couldn't be added, so it was taken off. You can send your message without it.");
	}

	// awaited, so the turn reads a stored copy. The bucket never stalls the turn: a write it
	// fails or takes too long on goes to the files table instead (storeChatAttachments). A long paste is
	// message text (CUR-1895 above), not a file the person gave Alpha, so it is stored out of My files
	// and its quota. CUR-3235: a signed-in person's full My files answers 413, so the client drops the
	// file and gives the text back. The composer refuses such a file at attach time; this is the race. (CUR-2183)
	const toStore = b64Files.map((file) => {
		const paste = file.type === CLIPBOARD_MIME && !refusableFiles.has(file);
		// Real bytes labelled as a paste are an attachment, stored and referenced under their sniffed
		// type: the reader picks the pastes folder from the reference's mime alone.
		if (paste || file.type !== CLIPBOARD_MIME) return { file, paste };
		return { file: new File([file], file.name, { type: sniffedType.get(file) ?? "application/octet-stream" }), paste };
	});
	// The 24-hour allowance bounds what one identity attaches across both stores. The composer
	// checks it at attach (GET /chat/api/attachment-allowance); this is the race, and a request that
	// skipped the composer. 413 for the same reason as a full My files: the file is what's refused. (CUR-3235)
	const allowanceOwner = attachmentOwner(conv, opts.clientAddress);
	const attachedSizes = toStore.filter((f) => !f.paste).map((f) => f.file.size);
	if (allowanceOwner && attachedSizes.length) {
		const left = await attachmentAllowanceLeft(allowanceOwner);
		const guest = !("userId" in allowanceOwner);
		// Off: count and log, store anyway (CUR-3600). The log is what the production decision reads.
		if (!fitsAllowance(left, attachedSizes) && !attachmentAllowanceEnforced()) {
			logger.info(
				{ guest, network: left?.network === true, files: attachedSizes.length },
				"[attachment-allowance] would refuse"
			);
		} else if (!fitsAllowance(left, attachedSizes)) {
			logger.info({ guest, network: left?.network === true, at: "send" }, "[attachment-allowance] refused");
			error(
				413,
				attachmentAllowanceMessage({
					guest,
					network: left?.network,
					resetsInMs: (left?.resetsAt?.getTime() ?? Date.now()) - Date.now(),
				})
			);
		}
	}
	let stored: NonNullable<Message["files"]>;
	try {
		stored = await storeChatAttachments(conv, toStore, {
			fault: b64Files.length ? await resolveFaultInjection(request) : null,
			location: b64Files.length ? await linkedAttachmentLocation(conv, flagEmail(locals.user)) : undefined,
		});
	} catch (e) {
		if (e instanceof StorageQuotaExceededError) error(413, myFilesFullMessage());
		throw e;
	}
	if (allowanceOwner && attachedSizes.length) await recordAttachments(allowanceOwner, attachedSizes);
	const uploadedFiles = [...stored, ...hashFiles];

	return {
		newPrompt,
		messageId,
		isRetry,
		agentAttach,
		generationId,
		newMessageIds,
		searchContext,
		webSearchMode: webSearchMode ?? "off",
		speakAll,
		speakMode,
		agentMode,
		autoRoute,
		uploadedFiles,
		attachmentNotice,
		leftOutFiles,
	};
}
