// PDQ hash-matching (HMA — Hasher-Matcher-Actioner, facebook/ThreatExchange) on every
// upload path, against the bank the HMA instance holds. Preview points at a Fly-hosted HMA with a
// placeholder test bank (CUR-2382); the real NCMEC bank replaces it as config (CUR-713).
//
// FAIL CLOSED, all three ways (CUR-2382):
// - No scanner configured (CSAM_SCAN_BASE_URL unset): scanCsamHash throws CsamScannerUnconfiguredError,
//   and csamScanConfigured() is false, which is what withholds the attach control in chat.
// - Configured but unreachable: HmaUnreachableError. Nothing is stored.
// - A match: the caller refuses, alerts and reports.
//
// CSAM_SCAN_TOKEN is the bearer the Fly deployment's proxy requires (web/hma/fly/). HMA itself has no
// auth, so the proxy forwards only POST /m/lookup: an open lookup would let anyone test images
// against the real bank once it is loaded, and an open curator API would let anyone edit the banks.
//
// HMA's own POST /m/lookup does hashing AND matching in one round trip — no PDQ library needed here.
// Live-probed against a local docker-compose HMA instance (web/hma/): a real image posted to this
// endpoint after being seeded into a bank returns `{"pdq":{"BANK":[{"bank_content_id":N,"distance":"0"}]}}`
// on a match, `{}` on no match — and `400 {"message":"invalid signal: invalid PDQ
// hash"}` for perfectly legitimate low-texture content (a solid-color image has no computable PDQ
// hash — this is PDQ's own behavior, not an HMA bug). That specific 400 is NOT a service failure and
// NOT a match; scanCsamHash treats it as "nothing to check" and returns "clean". A DIFFERENT 400 —
// such as a wrong form field (`{"message":"no such content_type: '...'"}`) and a missing
// upload (`{"message":"Missing multipart/form-data file upload"}`) — names a malformed request on our
// own side, with no bearing on the content itself, so scanCsamHash matches on the message text, not
// just the status, before calling anything "clean". (CUR-1136)

import { config } from "$lib/chat/server/config";

export type CsamScanResult =
	| { status: "clean" } // HMA answered; no bank matched (includes the "no computable hash" 400 case)
	| { status: "match"; bankName: string; bankContentId: number; distance: string };

export class HmaUnreachableError extends Error {
	constructor(cause: unknown) {
		super(`HMA scan endpoint unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "HmaUnreachableError";
		this.cause = cause;
	}
}

/**
 * The one line a person sees when a file is refused because it could not be scanned, whether no
 * scanner is configured or the configured one did not answer. Chat and My files both show it.
 */
export const UPLOAD_NOT_SCANNED_MESSAGE =
	"We couldn't check this file just now, so it wasn't added. Please try again in a minute.";

/** No scanner is configured (CSAM_SCAN_BASE_URL unset), so no file may be accepted. */
export class CsamScannerUnconfiguredError extends Error {
	constructor() {
		super("CSAM_SCAN_BASE_URL is unset, so uploads cannot be scanned and are refused");
		this.name = "CsamScannerUnconfiguredError";
	}
}

function csamScanBaseUrl(): string | undefined {
	const v = Reflect.get(config, "CSAM_SCAN_BASE_URL");
	return typeof v === "string" && v.trim() ? v.trim().replace(/\/$/, "") : undefined;
}

/** Is a scanner configured? The attach control and every upload path read this one answer. */
export function csamScanConfigured(): boolean {
	return csamScanBaseUrl() !== undefined;
}

function csamScanToken(): string | undefined {
	const v = Reflect.get(config, "CSAM_SCAN_TOKEN");
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// Same order of magnitude as the OpenAI-client timeouts elsewhere in this codebase
// (FORCED_TOOL_CALL_TIMEOUT_MS) — long enough for a real hash+match round trip, short enough that an
// unreachable scanner doesn't stall an upload response indefinitely.
const CSAM_SCAN_TIMEOUT_MS = 15_000;

// HMA is one small machine behind Caddy, so a gateway status or a dropped connection can be a
// moment's restart or a busy worker, which should not tell a person to "try again in a minute". One
// retry after a short pause clears that. A timeout is not retried (the scanner is already slow and a
// second wait doubles the upload), nor a 4xx or a 500, which the same bytes get again (a HEIC is a 500).
// After the retry the upload still fails closed. (CUR-4671)
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAY_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failure to reach HMA at all (refused, reset, DNS), as opposed to our own timeout firing. */
function isConnectionError(e: unknown): boolean {
	const name = e instanceof Error ? e.name : "";
	return name !== "TimeoutError" && name !== "AbortError";
}

/**
 * Hash `content` and check it against HMA's configured banks in one round trip. Throws
 * {@link CsamScannerUnconfiguredError} when no scan endpoint is configured, and
 * {@link HmaUnreachableError} on a network failure or an HTTP status this function doesn't have a
 * defined clean-content meaning for; the caller (uploadCustodialFile) is responsible for failing the
 * upload closed on that error, per the ticket's own instruction — this function never decides that
 * itself, so a future caller with a different risk posture isn't forced to inherit this one's.
 */
export async function scanCsamHash(
	content: Blob,
	filename: string,
	opts: { retryDelayMs?: number } = {}
): Promise<CsamScanResult> {
	const baseUrl = csamScanBaseUrl();
	if (!baseUrl) throw new CsamScannerUnconfiguredError();
	const token = csamScanToken();

	const lookup = () => {
		const form = new FormData();
		form.set("photo", content, filename);
		return fetch(`${baseUrl}/m/lookup?bypass_coinflip=true`, {
			method: "POST",
			body: form,
			...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
			signal: AbortSignal.timeout(CSAM_SCAN_TIMEOUT_MS),
		});
	};

	const attempt = async (last: boolean): Promise<Response | "retry"> => {
		try {
			const r = await lookup();
			return !last && TRANSIENT_STATUSES.has(r.status) ? "retry" : r;
		} catch (e) {
			if (last || !isConnectionError(e)) throw new HmaUnreachableError(e);
			return "retry";
		}
	};
	let first = await attempt(false);
	if (first === "retry") {
		await sleep(opts.retryDelayMs ?? RETRY_DELAY_MS);
		first = await attempt(true);
	}
	const res = first as Response;

	if (res.status === 400) {
		// A 400 is "clean" ONLY for the specific degenerate-hash case (see header) — every other 400
		// live-confirmed against HMA (a wrong form field, a missing upload) carries a distinct message
		// naming a malformed request on our side. Matching on the message, not just the status, keeps a
		// request-construction bug from silently reading as "clean" the moment CSAM_SCAN_BASE_URL is
		// ever set — exactly the fail-open this feature exists to avoid. An unparseable or unrecognized
		// 400 body falls through to HmaUnreachableError below.
		let message: unknown;
		try {
			message = ((await res.json()) as { message?: unknown })?.message;
		} catch {
			// leave message undefined — falls through to the unreachable throw below
		}
		if (typeof message === "string" && /invalid pdq hash/i.test(message)) {
			return { status: "clean" };
		}
		throw new HmaUnreachableError(`HTTP 400: ${typeof message === "string" ? message : "unrecognized body"}`);
	}
	if (!res.ok) {
		throw new HmaUnreachableError(`HTTP ${res.status}`);
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch (e) {
		throw new HmaUnreachableError(e);
	}

	// Shape: {"pdq": {"BANK_NAME": [{"bank_content_id": N, "distance": "0"}, ...], ...}}
	const pdq = (body as { pdq?: unknown })?.pdq;
	if (!pdq || typeof pdq !== "object") return { status: "clean" };
	for (const [bankName, matches] of Object.entries(pdq as Record<string, unknown>)) {
		if (!Array.isArray(matches) || matches.length === 0) continue;
		const first = matches[0] as { bank_content_id?: unknown; distance?: unknown };
		if (typeof first?.bank_content_id === "number") {
			return {
				status: "match",
				bankName,
				bankContentId: first.bank_content_id,
				distance: typeof first.distance === "string" ? first.distance : String(first.distance ?? "?"),
			};
		}
	}
	return { status: "clean" };
}
