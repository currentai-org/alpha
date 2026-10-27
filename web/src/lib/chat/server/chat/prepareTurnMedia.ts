// prepareTurnMedia — hydrate → extract → cap, ONCE per turn. The output is the ONLY source both the
// guard gate and the endpoint formatter may read: "one hydrate, one extraction, two consumers" is
// enforced by construction, not convention. The invariants it owns:
//
//   • finalText per user message is EXACTLY the text the endpoint will send — clipboard expansion,
//     then rendered file documents, then typed content. Clipboard expansion happens HERE, so the
//     gate sees the clipboard bytes the model receives. NOTE the order is clipboard-BEFORE-
//     documents; the endpoint formatter emits finalText verbatim, so this module is the source of
//     truth for that order.
//   • ONE corpus budget: typed text reserves its length out of GUARD_CORPUS_CAP first; clipboard +
//     RENDERED file segments (wrapper bytes counted) truncate into the remainder — newest message
//     first, clipboard before file segments within a
//     message. A truncated/dropped byte appears in NEITHER finalText NOR corpus, so screen.corpus ⊇
//     every file-derived byte any finalText contains (the superset invariant).
//   • Images are (sha, sourceMessage) OCCURRENCES: duplicates dedupe within one message
//     only, the retained list caps at MAX_TURN_IMAGES newest occurrences, and each unit's caption
//     is a bounded PREFIX of ITS OWN message's finalText — the same text-image pair the
//     endpoint serves. Over-cap occurrences are excluded from BOTH the screen and the payload.
//   • Failures are UNITS, not absences: a hydration / decode / sharp failure appends a
//     FailedUnit (the gate merges it as UNKNOWN — child closes) and the file is excluded from
//     finalText/images, so the model never receives what the gate could not read.
//   • Mime is decided from the HYDRATED/stored record, never the client-supplied ref mime.
//   • Zero-file fast path: no user message carries files → no DB read, no sharp, ~0 ms — a turn
//     without files pays nothing.

import sharp from "sharp";
import type { ObjectId } from "bson";
import type { Message } from "$lib/chat/types/Message";
import { AttachmentReadError, downloadFile, type AttachmentOwner } from "$lib/chat/server/files/downloadFile";
import { turnKeyStore } from "$lib/chat/server/storage/custodialStorage";
import { stripDeclinedTurns } from "$lib/chat/server/textGeneration/stripDeclinedTurns";
import { CLIPBOARD_MIME, DOCX_MIME } from "$lib/chat/constants/mime";
import { isTextMime } from "$lib/chat/server/chat/attachmentType";
import { extractTextFromUpload, RagExtractError } from "$lib/chat/server/rag/extractFile";
import type { UploadKind } from "$lib/chat/constants/ragUpload";
import { logger as defaultLogger } from "$lib/chat/server/logger";
import {
	GUARD_CORPUS_CAP,
	IMAGE_CAPTION_CAP,
	MAX_TURN_IMAGES,
	type FailedUnit,
	type GuardScreenInput,
	type PreparedImage,
} from "$lib/chat/server/guardScreenTypes";

type PreparedMessageMedia = {
	/** EXACTLY the text the endpoint will send for this message (clipboard + documents + typed). */
	finalText: string;
	/** The clipboard and document part of `finalText`, without the typed text; "" when none survived the
	 *  budget. The agent endpoint keeps it whole where it cuts an earlier turn's text short (CUR-4104). */
	attachedText: string;
	/** Retained image occurrences riding in this message, in file order. */
	images: PreparedImage[];
};

export type PreparedTurnMedia = {
	/** Keyed by Message.id — user messages that carried files, in prompt order (Map preserves
	 *  insertion order). A user message with no files is absent; the endpoint uses its raw content. */
	messages: Map<string, PreparedMessageMedia>;
	/** What the gate screens — the shared GuardScreenInput derived from the same fields the endpoint
	 *  consumes (task contract: `screen`; the plan text calls this `screenUnits`). */
	screen: GuardScreenInput;
	truncatedFiles: { name: string; droppedBytes: number }[];
	/** Earlier user messages that lost pasted or attached text to the corpus budget, which fills
	 *  newest first. The model never reads what was cut, so the answer says older messages were
	 *  left out, the same as when history fitting drops them (CUR-2893). */
	olderMessagesCut: number;
	droppedImages: number;
	/** Attached files this turn could not read, by the name the person gave them (CUR-3291). The model
	 *  never saw them, so the turn says which ones; `unreadable` means the bucket errored and asking
	 *  again can work, `missing` means the file is gone. */
	unreadFiles: { name: string; reason: "unreadable" | "missing" }[];
};

export type PrepareTurnMediaDeps = {
	/** The signed-in owner of the conversation, so each attachment is read from their My files copy
	 *  first (CUR-2183). Absent for a guest, who passes guestSessionId instead. */
	ownerId?: string;
	/** A guest conversation's session, whose bucket copy is read first (CUR-2183); for a conversation
	 *  moved to an account at sign-in, its former session, read after the owner's copy. */
	guestSessionId?: string;
	/** Preview-only fault for the attachment read (faultInjection.ts, CUR-3291). */
	fault?: AttachmentOwner["fault"];
	/** Injected for tests; defaults to the real downloadFile. */
	downloadFile?: typeof downloadFile;
	/** Injected for tests; defaults to the real sharp. Used for the bounded screening rendition. */
	sharpImpl?: typeof sharp;
	/** base64 → utf-8, FATAL by default so undecodable file bytes become a text-decode FailedUnit
	 *  (UNKNOWN unit) rather than silently reaching the model as replacement chars. */
	decodeText?: (base64: string) => string;
	logger?: Pick<typeof defaultLogger, "info" | "warn">;
	/** Read attached PDF/DOCX files to text. The route sets it only when the
	 *  `document-attachments` flag is on AND this turn is screened on the guard path, the one path (CUR-987)
	 *  that screens file text. Off, a document is left out of the prompt, as before. */
	readDocuments?: boolean;
	/** Injected for tests; defaults to rag/extractFile.ts's extractor. */
	extractDocument?: typeof extractTextFromUpload;
};

/** The extractor kind for a document mime, or null for anything that is not a readable document. */
function documentKind(mime: string): Extract<UploadKind, "pdf" | "docx"> | null {
	const m = (mime || "").toLowerCase();
	if (m === "application/pdf") return "pdf";
	if (m === DOCX_MIME) return "docx";
	return null;
}

/** FATAL base64→utf-8: throws on malformed utf-8 so the caller records a text-decode FailedUnit. */
function decodeBase64Utf8Fatal(base64: string): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(base64, "base64"));
}

/** A value safe inside a double-quoted attribute of the `<document>` wrapper. */
function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** finalText layout: clipboard segments, then rendered file documents, then typed content — the
 *  task contract's "clipboard before file-document splices". Empty parts are dropped cleanly. */
function composeFinalText(clipboard: string[], documents: string[], typed: string): string {
	const attached = composeAttachedText(clipboard, documents);
	return attached ? `${attached}\n\n${typed}` : typed;
}

/** The clipboard and document part of finalText, in the same order; "" when there is none. */
function composeAttachedText(clipboard: string[], documents: string[]): string {
	const clip = clipboard.filter((c) => c.length > 0).join("\n\n");
	const docs = documents.filter((d) => d.length > 0).join("\n\n");
	return [clip, docs].filter((part) => part.length > 0).join("\n\n");
}

// Internal per-message working shape, built during hydration, budgeted afterwards.
type MessageWork = {
	id: string;
	typed: string;
	hadFiles: boolean;
	/** Decoded clipboard segments, file order. Budget order: these before file segments. */
	clipboardSegments: string[];
	/** Rendered `<document …>` segments (wrappers included), file order. */
	fileSegments: { name: string; rendered: string }[];
	/** Image occurrences (deduped by sha within this message), file order. */
	imageRefs: { sha: string; mime: string; source: Buffer }[];
};

export async function prepareTurnMedia(
	messages: Message[],
	convId: ObjectId,
	deps: PrepareTurnMediaDeps = {}
): Promise<PreparedTurnMedia> {
	const log = deps.logger ?? defaultLogger;
	const userMessages = messages.filter((m) => m.from === "user");

	// ── Zero-file fast path (plan r3 #2): no DB read, no sharp, no awaited I/O. The prepared Map is
	// empty — a file-less message is not an entry; the endpoint uses its raw content. ───────────────
	if (userMessages.every((m) => !m.files || m.files.length === 0)) {
		return {
			messages: new Map(),
			screen: {
				corpus: userMessages.map((m) => m.content).join("\n\n"),
				typedTurnText: userMessages.at(-1)?.content ?? "",
				images: [],
				failedUnits: [],
			},
			truncatedFiles: [],
			olderMessagesCut: 0,
			droppedImages: 0,
			unreadFiles: [],
		};
	}

	const download = deps.downloadFile ?? downloadFile;
	// One per turn: every attachment of one owner then costs one key read, and the next turn reads
	// the key again, so a wipe's tombstone is never missed (CUR-4116).
	const keys = turnKeyStore();
	const decodeText = deps.decodeText ?? decodeBase64Utf8Fatal;
	const extractDocument = deps.extractDocument ?? extractTextFromUpload;
	const failedUnits: FailedUnit[] = [];
	const unreadFiles: PreparedTurnMedia["unreadFiles"] = [];

	// ── Hydrate + classify, per user message. All files are hash refs by this point (parseRequest
	// uploads base64 before the tree is built — plan r2 #7), so file.value IS the sha. Classification
	// uses the HYDRATED mime; the client ref mime is never trusted (plan r1 #4). ────────────────────
	const work: MessageWork[] = await Promise.all(
		userMessages.map(async (m, i): Promise<MessageWork> => {
			const w: MessageWork = {
				id: m.id,
				typed: m.content,
				hadFiles: (m.files?.length ?? 0) > 0,
				clipboardSegments: [],
				fileSegments: [],
				imageRefs: [],
			};
			const seenImageShas = new Set<string>();
			for (const ref of m.files ?? []) {
				const sha = ref.value;
				// The name the person gave the file. The stored record's name is the `${convId}-${sha}`
				// storage key, which means nothing to the model or to them.
				const displayName = ref.name || "attachment";
				let hydrated: Awaited<ReturnType<typeof downloadFile>>;
				try {
					hydrated = await download(sha, convId, {
						ownerId: deps.ownerId,
						guestSessionId: deps.guestSessionId,
						name: ref.name,
						mime: ref.mime,
						location: ref.location,
						fault: deps.fault,
						keys,
					});
				} catch (err) {
					// A file the bucket would not read back never reaches the model, so the guard has nothing
					// unscreened; counting it as a failed unit would fail child safety closed and decline the turn
					// before the notice could name it (CUR-3291).
					if (err instanceof AttachmentReadError) {
						unreadFiles.push({ name: displayName, reason: "unreadable" });
						continue;
					}
					failedUnits.push({ kind: "file-hydration", sha });
					// A file deleted from an older message would otherwise repeat its notice on every later turn.
					if (i === userMessages.length - 1) unreadFiles.push({ name: displayName, reason: "missing" });
					continue;
				}
				const mime = hydrated.mime;
				if (mime === CLIPBOARD_MIME) {
					// Clipboard is ours to expand HERE (plan r2 #2). Not in the text allowlist — always text.
					try {
						w.clipboardSegments.push(decodeText(hydrated.value));
					} catch {
						failedUnits.push({ kind: "text-decode", sha });
					}
				} else if (mime.startsWith("image/")) {
					// Dedupe identical shas WITHIN one message only — cross-message occurrences are distinct
					// (text, image) pairs the endpoint serves separately (plan r4 #2).
					if (seenImageShas.has(sha)) continue;
					seenImageShas.add(sha);
					w.imageRefs.push({ sha, mime, source: Buffer.from(hydrated.value, "base64") });
				} else if (isTextMime(mime)) {
					try {
						const content = decodeText(hydrated.value);
						// The person's file name, never hydrated.name: that is the storage id (`<conv>-<sha>`), which
						// the model then cites in the answer as if it were the document's name.
						w.fileSegments.push({
							name: displayName,
							rendered: `<document name="${escapeAttr(displayName)}" type="${mime}">\n${content}\n</document>`,
						});
					} catch {
						failedUnits.push({ kind: "text-decode", sha });
					}
				} else if (deps.readDocuments && documentKind(mime)) {
					// A PDF or DOCX joins the prompt as text, rendered like an attached text
					// file, so the guard screens it inside the corpus. A document with no readable text (a
					// scanned PDF, a corrupt file) still reaches the model as an empty element saying why,
					// so the answer can tell the person rather than ignore the file. (CUR-987)
					const kind = documentKind(mime)!;
					const started = Date.now();
					try {
						const { text } = await extractDocument({
							bytes: Buffer.from(hydrated.value, "base64"),
							name: displayName,
							kind,
						});
						w.fileSegments.push({
							name: displayName,
							rendered: `<document name="${escapeAttr(displayName)}" type="${mime}">\n${text}\n</document>`,
						});
						log.info({ kind, chars: text.length, ms: Date.now() - started }, "[media-prep] document read");
					} catch (err) {
						if (err instanceof RagExtractError) {
							w.fileSegments.push({
								name: displayName,
								rendered: `<document name="${escapeAttr(displayName)}" type="${mime}" unreadable="${escapeAttr(err.message)}" />`,
							});
							log.info({ kind, ms: Date.now() - started }, "[media-prep] document unreadable");
						} else {
							failedUnits.push({ kind: "document-extract", sha });
							log.warn({ kind, ms: Date.now() - started }, "[media-prep] document extraction failed");
						}
					}
				} else {
					// Neither text-allowlisted nor image nor clipboard — the pre-swap formatter dropped these
					// silently; keep the drop but say so (labels only, never content).
					log.info({ mime }, "[media-prep] unsupported mime dropped from prompt");
				}
			}
			return w;
		})
	);

	// ── ONE corpus budget over the exact endpoint text (plan r2 #1 / r4 #1 / r3 #6). Only typed
	// text is never truncated; clipboard + rendered file segments consume the remainder — newest
	// message first, clipboard before file segments within a message. The budgeted quantity is the
	// RENDERED segment, wrappers included. ─────────────────────────────────────────────────────────
	const typedTotal = work.reduce((sum, w) => sum + w.typed.length, 0);
	let budget = Math.max(0, GUARD_CORPUS_CAP - typedTotal);
	const truncatedFiles: { name: string; droppedBytes: number }[] = [];
	const keptClipboard = new Map<MessageWork, string[]>();
	const keptFileSegments = new Map<MessageWork, string[]>();

	const takeFromBudget = (name: string, segment: string): string => {
		const keep = Math.min(segment.length, budget);
		budget -= keep;
		if (keep < segment.length) {
			truncatedFiles.push({ name, droppedBytes: segment.length - keep });
		}
		return segment.slice(0, keep);
	};

	let olderMessagesCut = 0;
	for (const w of [...work].reverse()) {
		const cutBefore = truncatedFiles.length;
		// Allocation order is newest-first; clipboard before file segments; each keeps in-message order.
		keptClipboard.set(
			w,
			w.clipboardSegments.map((seg) => takeFromBudget("clipboard", seg))
		);
		keptFileSegments.set(
			w,
			w.fileSegments.map((seg) => takeFromBudget(seg.name, seg.rendered))
		);
		if (w !== work.at(-1) && truncatedFiles.length > cutBefore) olderMessagesCut++;
	}
	if (truncatedFiles.length > 0) {
		log.info(
			{
				truncated: truncatedFiles.length,
				droppedBytes: truncatedFiles.reduce((s, t) => s + t.droppedBytes, 0),
			},
			"[media-prep] file text truncated into the corpus budget"
		);
	}

	// ── finalText per message (clipboard, documents, typed). ───────────────────────────────────────
	const finalTexts = new Map<MessageWork, string>(
		work.map((w) => [
			w,
			composeFinalText(keptClipboard.get(w) ?? [], keptFileSegments.get(w) ?? [], w.typed),
		])
	);

	// ── Image occurrence cap (plan "Image set + cap"): flattened prompt order, keep the NEWEST
	// MAX_TURN_IMAGES (later message = newer; within a message, file order), drop the oldest. The
	// gate cannot screen fewer images than the endpoint sends because BOTH read this one list. ─────
	const occurrences = work.flatMap((w) => w.imageRefs.map((ref) => ({ w, ref })));
	const retained = occurrences.slice(Math.max(0, occurrences.length - MAX_TURN_IMAGES));
	const droppedImages = occurrences.length - retained.length;
	if (droppedImages > 0) {
		log.info(
			{ droppedImages, cap: MAX_TURN_IMAGES },
			"[media-prep] image occurrences over cap dropped from screen AND payload"
		);
	}

	// Screening rendition: bounded bytes for the guard (sharp fit-inside 1024×1024 JPEG q85), never
	// the endpoint's imageProcessor (endpoint-specific, resolved only at generation time — plan r1
	// #7). Source-file identity, not pixel identity, is the contract. A sharp failure is a FailedUnit
	// (UNKNOWN unit), and the image is excluded from the payload too.
	const sharpFn = deps.sharpImpl ?? sharp;
	const perMessageImages = new Map<MessageWork, PreparedImage[]>(work.map((w) => [w, []]));
	const screenImages: PreparedImage[] = [];
	for (const { w, ref } of retained) {
		let screenB64: string;
		try {
			const encoded = await sharpFn(ref.source)
				.resize({ width: 1024, height: 1024, fit: "inside" })
				.jpeg({ quality: 85 })
				.toBuffer();
			screenB64 = encoded.toString("base64");
		} catch {
			failedUnits.push({ kind: "image-encode", sha: ref.sha });
			continue;
		}
		const img: PreparedImage = {
			sha: ref.sha,
			mime: ref.mime,
			source: ref.source,
			screenB64,
			sourceMessageId: w.id,
			// Bounded prefix of the SOURCE message's finalText — clipboard + rendered file segments
			// included — so the guard judges the pair the endpoint actually serves (plan r5 #1).
			caption: (finalTexts.get(w) ?? "").slice(0, IMAGE_CAPTION_CAP),
		};
		perMessageImages.get(w)?.push(img);
		screenImages.push(img);
	}

	// ── Prepared per-message media: ONLY user messages that carried files (plan "only user messages
	// with files get entries"). corpus below is built from ALL user messages regardless. ────────────
	const prepared = new Map<string, PreparedMessageMedia>();
	for (const w of work) {
		if (!w.hadFiles) continue;
		prepared.set(w.id, {
			finalText: finalTexts.get(w) ?? w.typed,
			attachedText: composeAttachedText(keptClipboard.get(w) ?? [], keptFileSegments.get(w) ?? []),
			images: perMessageImages.get(w) ?? [],
		});
	}

	return {
		messages: prepared,
		screen: {
			corpus: work.map((w) => finalTexts.get(w) ?? w.typed).join("\n\n"),
			// Coop scope is PINNED to the current typed turn text (plan r3 #3) — file/history bytes
			// never go to the vendor.
			typedTurnText: work.at(-1)?.typed ?? "",
			images: screenImages,
			failedUnits,
		},
		truncatedFiles,
		olderMessagesCut,
		droppedImages,
		unreadFiles,
	};
}

/** The gate-feeding media pass. Trim moderation-DECLINED turns FIRST — the same trim the model prompt
 *  gets (textGeneration/index.ts) — THEN hydrate/extract/cap. A declined turn stays in stored history
 *  (the flagged user request + a canned decline), and the guard-primary gate screens `screen.corpus` =
 *  every user message joined, so an un-trimmed history re-feeds the flagged request into the corpus of
 *  every LATER turn and the guard re-fires on it: one decline then blocks every following message (the
 *  input-gate half of a cross-turn spillage). Trimming here screens the CURRENT turn, not
 *  the adjudicated past. The Coop branch reads typedTurnText only, so it was never affected; the
 *  endpoint strips the same turns and looks its per-message media up by id, so dropping declined-turn
 *  entries changes nothing it sends. The route's ONE gate-feeding call goes through here so "the
 *  screened corpus excludes adjudicated declined history" is a TEST, not a convention (cf. inputGate). */
export function prepareScreenedTurnMedia(
	messages: Message[],
	convId: ObjectId,
	deps: PrepareTurnMediaDeps = {}
): Promise<PreparedTurnMedia> {
	return prepareTurnMedia(stripDeclinedTurns(messages), convId, deps);
}

/** What the output screen's asker-context rules read as "the person asked" (CUR-1837): the newest user
 *  message's typed text, then everything it attached. An answer that quotes names from an attached rota
 *  is otherwise judged as exposing people the person never mentioned. The typed question goes first
 *  because the guard caps asker context from the front, so a long file can't push the question out. */
export function outputAskerText(messages: Message[], prepared: PreparedTurnMedia | undefined): string {
	const newest = [...messages].reverse().find((m) => m.from === "user");
	if (!newest) return "";
	const typed = newest.content ?? "";
	const finalText = prepared?.messages.get(newest.id)?.finalText;
	if (!finalText || finalText === typed) return typed;
	return typed.trim() ? `${typed}\n\n${finalText}` : finalText;
}
