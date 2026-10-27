import { isHostLocalhost } from "$lib/chat/server/isURLLocal";

/**
 * Decide the Access-Control-Allow-Origin value for an `/api/*` response. Pure and exported for
 * testing (CUR-1172 sibling) — `validOrigins` must include the request's own host, not just static
 * config, or a same-origin caller on a deployment PUBLIC_ORIGIN doesn't name (every ephemeral per-PR
 * preview) gets denied incorrectly. Returns undefined when the origin isn't recognized — deny by
 * default, never echo back a stale, mismatched static value.
 */
export function resolveApiCorsOrigin(
	requestOrigin: string | null,
	validOrigins: string[],
	opts: { dev: boolean }
): string | undefined {
	if (opts.dev || !requestOrigin || isHostLocalhost(new URL(requestOrigin).hostname)) {
		return "*";
	}
	if (validOrigins.includes(requestOrigin)) {
		return requestOrigin;
	}
	return undefined;
}
