import { parseExternalUrl } from "$lib/chat/utils/externalLink";
import { sanitizeUrlParam } from "$lib/chat/utils/urlParams";

/**
 * What a deep link into `/chat` or `/chat/models/<id>` asked for. Read once on mount and held in
 * memory: the URL is stripped of these params as soon as they are read, so a reload or Back cannot
 * replay them. Ported from upstream chat-ui 5418e752 (CUR-2644).
 */
export interface LinkPromptRequest {
	/** Text from `q` or `prompt`; `q` wins when both are present. */
	prompt: string | null;
	/** Absolute http(s) URLs without credentials, in link order, deduplicated. Anything else is dropped. */
	attachmentUrls: URL[];
	/** Whether the link asked for the prompt to be sent (`q`) rather than placed in the composer (`prompt`). */
	send: boolean;
}

export const LINK_PARAM_NAMES = ["q", "prompt", "attachments"] as const;

/** `?attachments=` takes comma-separated URLs in one param, repeated params, or both. */
function parseAttachmentUrls(params: URLSearchParams): URL[] {
	const seen = new Set<string>();
	const urls: URL[] = [];
	for (const param of params.getAll("attachments")) {
		for (const raw of param.split(",")) {
			const url = parseExternalUrl(raw.trim());
			if (!url || seen.has(url.href)) continue;
			seen.add(url.href);
			urls.push(url);
		}
	}
	return urls;
}

/** `null` when the URL carries nothing for the composer. */
export function readLinkPromptRequest(params: URLSearchParams): LinkPromptRequest | null {
	const q = sanitizeUrlParam(params.get("q"));
	const prompt = q ?? sanitizeUrlParam(params.get("prompt"));
	const attachmentUrls = parseAttachmentUrls(params);
	if (!prompt && attachmentUrls.length === 0) return null;
	return { prompt, attachmentUrls, send: q !== null };
}

/**
 * Whether the visitor must say yes before anything is fetched or sent. Upstream skips the question
 * for attachments from paths Hugging Face publishes itself. Nothing here plays that role, so every
 * attachment asks. A `prompt` link with no attachments only fills the composer, and the visitor still
 * presses send, so it goes straight through.
 */
export function linkPromptNeedsConfirmation(request: LinkPromptRequest): boolean {
	return request.send || request.attachmentUrls.length > 0;
}
