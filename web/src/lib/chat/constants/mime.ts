// Centralized MIME allowlists used across client and server
// Keep these lists minimal and consistent with server processing.

export const TEXT_MIME_ALLOWLIST = [
	"text/*",
	"application/json",
	"application/xml",
	"application/csv",
] as const;

/** A long paste the composer sends as a file (CUR-1895); the turn reads it back as message text. */
export const CLIPBOARD_MIME = "application/vnd.chatui.clipboard";

export const IMAGE_MIME_ALLOWLIST_DEFAULT = ["image/jpeg", "image/png"] as const;

// What a model's `image/*` means in the composer. A browser draws these in an `<img>`; a
// TIFF it can't, so it attached as a broken thumbnail. (CUR-3051)
export const IMAGE_MIME_RENDERABLE = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

// Documents the server reads to text before the turn is screened. Offered only while the
// `document-attachments` flag is on. (CUR-987)
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const DOCUMENT_MIME_ALLOWLIST = ["application/pdf", DOCX_MIME] as const;
