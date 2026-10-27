import { replaceState } from "$app/navigation";
import { page } from "$app/state";
import { tick } from "svelte";
import { error } from "$lib/chat/stores/errors";
import { requireAuthUser } from "$lib/chat/utils/auth";
import {
	LINK_PARAM_NAMES,
	readLinkPromptRequest,
	type LinkPromptRequest,
} from "$lib/chat/utils/linkParams";
import { loadAttachmentsFromUrls } from "$lib/chat/utils/loadAttachmentsFromUrls";

/**
 * Reads the current URL's deep link and strips it, so a reload or Back/Forward cannot replay it. The
 * request lives in memory from here on. `null` when the URL carries nothing, or when the visitor is
 * being sent to log in first (that redirect comes back to this URL, params included). Shared by
 * `/chat` (ChatLanding) and `/chat/models/<id>` (CUR-2644).
 */
export function takeLinkPromptRequest(): LinkPromptRequest | null {
	const request = readLinkPromptRequest(page.url.searchParams);
	if (!request || requireAuthUser()) return null;
	const url = new URL(page.url);
	for (const name of LINK_PARAM_NAMES) url.searchParams.delete(name);
	tick().then(() => {
		replaceState(url, page.state);
	});
	return request;
}

/** What a route hands over so a confirmed link can act on its composer. */
export interface LinkPromptTarget {
	attach(files: File[]): void;
	/** Place the prompt in the composer, unless the visitor already typed something. */
	fill(prompt: string): void;
	send(prompt: string): Promise<void>;
	/**
	 * True once the route has unmounted. A confirmed request can still be loading attachments when
	 * the visitor moves on, and a send from a page that is gone would pull them into a conversation
	 * they never saw being created.
	 */
	gone(): boolean;
}

/** Runs once the visitor confirmed, or straight away when nothing needed confirming. */
export async function applyLinkPromptRequest(
	request: LinkPromptRequest,
	target: LinkPromptTarget
): Promise<void> {
	try {
		if (request.attachmentUrls.length > 0) {
			const result = await loadAttachmentsFromUrls(request.attachmentUrls.map((url) => url.href));
			if (target.gone()) return;
			target.attach(result.files);
			if (result.errors.length > 0) {
				console.error("Failed to load some attachments:", result.errors);
				error.set(`Failed to load ${result.errors.length} attachment(s). Check console for details.`);
			}
		}
		if (request.send && request.prompt) await target.send(request.prompt);
		else if (request.prompt) target.fill(request.prompt);
	} catch (err) {
		console.error("Failed to process URL parameters:", err);
	}
}
