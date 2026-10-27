import { error } from "@sveltejs/kit";
import { logger, securityLogger } from "$lib/chat/server/logger.js";
import { isValidUrlStrict, ssrfStrictFetch } from "$lib/chat/server/urlSafety";
import { fetchUrlAllowed } from "$lib/chat/server/db/fetchUrlRate";
import { readCappedBytes } from "$lib/chat/server/readCappedBody";
import { CHAT_ATTACHMENTS_MAX_BYTES, chatAttachmentsTooLargeMessage } from "$lib/chat/constants/uploadLimits";

const FETCH_TIMEOUT = 30000; // 30 seconds
const MAX_REDIRECTS = 5;
const SECURITY_HEADERS: HeadersInit = {
	// Prevent any active content from executing if someone navigates directly to this endpoint.
	"Content-Security-Policy":
		"default-src 'none'; frame-ancestors 'none'; sandbox; script-src 'none'; img-src 'none'; style-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
};

/**
 * Fetch a URL a visitor attached by link, for the composer (loadAttachmentsFromUrls.ts).
 *
 * CUR-3191 hardening. Only a caller with a session the server already issued is served: a request
 * that had to mint one (no cookie, or a value the server never issued) gets a 401, and hooks/handle.ts
 * sets no cookie on this path. Each session and each IP is limited (db/fetchUrlRate.ts). The fetch uses
 * the strict SSRF guard, which also refuses the cluster-internal ranges (10/8, IPv6 ULA) the default
 * allows, on the first hop and every redirect. The body is read with a byte cap, so an oversized
 * response is cut off as it streams in. The answer is `private, no-store`: it is per-visitor, and no
 * shared cache should hold it.
 */
export async function GET({ url, locals, getClientAddress }) {
	if (!locals.user && locals.guestSessionMinted) {
		throw error(401, "Reload the page to start a session, then try the link again.");
	}

	const targetUrl = url.searchParams.get("url");

	if (!targetUrl) {
		logger.warn("Missing 'url' parameter");
		throw error(400, "Missing 'url' parameter");
	}

	if (!isValidUrlStrict(targetUrl)) {
		logger.warn({ targetUrl }, "Invalid or unsafe URL (only HTTPS is supported)");
		throw error(400, "Invalid or unsafe URL (only HTTPS is supported)");
	}

	const verdict = await fetchUrlAllowed({
		userId: locals.user?._id?.toString() ?? locals.sessionId,
		clientAddress: getClientAddress(),
	});
	if (verdict === "session") {
		throw error(429, "Too many links fetched in the last minute. Wait a minute and try again.");
	}
	if (verdict === "ip") {
		throw error(
			429,
			"Too many links are being fetched from your network right now. If you're at an event sharing Wi-Fi, wait a minute and try again."
		);
	}

	// One timeout covers every hop and the body read, so a slow drip is cut off too.
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
	try {
		const response = await fetchFollowingSafeRedirects(targetUrl, controller.signal);

		if (!response.ok) {
			logger.error({ targetUrl, response }, "Error fetching URL. Response not ok.");
			throw error(response.status, `Failed to fetch: ${response.statusText}`);
		}

		const contentLength = response.headers.get("content-length");
		if (contentLength && parseInt(contentLength) > CHAT_ATTACHMENTS_MAX_BYTES) {
			throw error(413, chatAttachmentsTooLargeMessage());
		}

		const body = await readCappedBytes(response, CHAT_ATTACHMENTS_MAX_BYTES);
		if (!body) {
			throw error(413, chatAttachmentsTooLargeMessage());
		}

		// Sent as text/plain for safety; the original type travels in a secondary header.
		const contentDisposition = response.headers.get("content-disposition");
		const headers: HeadersInit = {
			"Content-Type": "text/plain; charset=utf-8",
			"X-Forwarded-Content-Type": response.headers.get("content-type") || "application/octet-stream",
			"Cache-Control": "private, no-store",
			...(contentDisposition ? { "Content-Disposition": contentDisposition } : {}),
			...SECURITY_HEADERS,
		};
		return new Response(body, { headers });
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Follow up to MAX_REDIRECTS hops by hand, checking each target with the strict guard. */
async function fetchFollowingSafeRedirects(targetUrl: string, signal: AbortSignal): Promise<Response> {
	let currentUrl = targetUrl;
	for (let redirectCount = 0; ; redirectCount++) {
		const response = await ssrfStrictFetch(currentUrl, {
			signal,
			redirect: "manual",
			headers: {
				"User-Agent": "aipotluck.org-attachment-fetcher/1.0 (+https://www.aipotluck.org)",
			},
		});
		if (response.status < 300 || response.status >= 400) return response;

		if (redirectCount >= MAX_REDIRECTS) {
			throw error(502, "Too many redirects");
		}
		const location = response.headers.get("location");
		if (!location) {
			throw error(502, "Redirect without Location header");
		}
		const redirectUrl = new URL(location, currentUrl).toString();
		if (!isValidUrlStrict(redirectUrl)) {
			securityLogger.warn({ redirectUrl, originalUrl: targetUrl }, "Redirect to unsafe URL blocked (SSRF)");
			throw error(403, "Redirect target is not allowed");
		}
		currentUrl = redirectUrl;
	}
}
