// Can a person attach a PDF or Word document in chat and ask about it? (CUR-987)
//
// The `document-attachments` flag decides. A document is read on the server with the parsers the
// admin corpus already uses (rag/extractFile.ts: unpdf for PDF, mammoth for DOCX), and its text joins
// the turn exactly as an attached plain-text file does, so the guard screens it with everything else.
//
// The flag alone does not open it. A document also needs the turn to be screened on the guard path:
// the Coop branch screens only the typed text (inputGate.ts), so on that branch an extracted document
// would reach the model unread by any screen. That condition is a fact about the turn rather than
// about the deployment, so prepareTurnMedia asks for it per turn (see `documentsReadable`) instead of
// this gate folding it in.
//
// Attachments as a whole stay behind the `multimodal` flag and a configured CSAM scanner
// (parseRequest.ts), which this does not change.
//
// Fallback is OFF: a new, not-yet-trusted surface fails closed if PostHog was never polled.

import { flagEnabledOr } from "$lib/chat/server/flags";
import { guardPrimaryEnabled } from "$lib/chat/server/guardGate";
import { multimodalEnabled } from "$lib/chat/server/multimodalMode";

/** PostHog flag key. Owner: chat. Remove once document attachments are permanently on. */
export const DOCUMENT_ATTACHMENTS_FLAG = "document-attachments";

/** PostHog flag key for the text-only workaround: where `document-attachments` does not select the
 *  account, a PDF or DOCX is reduced to its text before anything is stored, and its original bytes
 *  and pictures are dropped (storage/documentTextOnly.ts). Owner: chat. */
export const DOCUMENT_TEXT_ONLY_FLAG = "document-text-only";

/** Is the document-attachment surface on for this account? Sync, never throws. */
export function documentAttachmentsEnabled(): boolean {
	return flagEnabledOr(DOCUMENT_ATTACHMENTS_FLAG, () => false);
}

/** Is a PDF or DOCX accepted as text only for this account? Off where the full surface is on, which
 *  already reads the document whole. Sync, never throws. */
export function documentTextOnlyEnabled(): boolean {
	return !documentAttachmentsEnabled() && flagEnabledOr(DOCUMENT_TEXT_ONLY_FLAG, () => false);
}

/** Should the composer offer PDF and DOCX? Only when a document sent now would be read: the flag is
 *  on, attachments are accepted at all (`multimodal`, else parseRequest answers 415), and the guard
 *  screens the turn. Offering it otherwise leads to a file the model never sees. */
export function documentAttachmentsOffered(): boolean {
	return (
		(documentAttachmentsEnabled() || documentTextOnlyEnabled()) && multimodalEnabled() && guardPrimaryEnabled()
	);
}
