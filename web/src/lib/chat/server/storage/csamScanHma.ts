// The `hma` scan provider: PDQ hash-matching through a self-run HMA instance (Hasher-Matcher-Actioner,
// facebook/ThreatExchange). It hashes and matches in one round trip, so no PDQ library is needed here.
// No hosted deployment of ours runs HMA; this adapter is for an operator who runs their own, with the
// bank they hold.
//
// HMA has no auth of its own, so an instance reachable over a network belongs behind a proxy that
// requires a bearer (CSAM_SCAN_TOKEN) and forwards only POST /m/lookup: an open lookup would let anyone
// test images against the bank, and an open curator API would let anyone edit it.
//
// What POST /m/lookup answers: `{"pdq":{"BANK":[{"bank_content_id":N,"distance":"0"}]}}` on a match,
// `{}` on no match, and `400 {"message":"invalid signal: invalid PDQ hash"}` for legitimate low-texture
// content (a solid-color image has no computable PDQ hash, which is PDQ's own behavior). That one 400 is
// read as "nothing to check" and returns clean. Any other 400 (a wrong form field, a missing upload)
// names a malformed request on our side, so the message text has to match as well as the status before
// anything is called clean.

import { CsamScannerUnreachableError, type CsamScanProvider } from "./csamScan";

// Long enough for a real hash+match round trip, short enough that an unreachable scanner doesn't stall
// an upload response indefinitely.
const TIMEOUT_MS = 15_000;

// A gateway status or a dropped connection can be a moment's restart or a busy worker, which should not
// tell a person to "try again in a minute". One retry after a short pause clears that. A timeout is not
// retried (the scanner is already slow and a second wait doubles the upload), nor a 4xx or a 500, which
// the same bytes get again (a HEIC is a 500). After the retry the upload still fails closed.
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAY_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failure to reach the scanner at all (refused, reset, DNS), as opposed to our own timeout firing. */
function isConnectionError(e: unknown): boolean {
	const name = e instanceof Error ? e.name : "";
	return name !== "TimeoutError" && name !== "AbortError";
}

export const hmaProvider: CsamScanProvider = {
	name: "hma",
	async scan(content, filename, { baseUrl, token, retryDelayMs }) {
		const lookup = () => {
			const form = new FormData();
			form.set("photo", content, filename);
			return fetch(`${baseUrl}/m/lookup?bypass_coinflip=true`, {
				method: "POST",
				body: form,
				...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		};

		const attempt = async (last: boolean): Promise<Response | "retry"> => {
			try {
				const r = await lookup();
				return !last && TRANSIENT_STATUSES.has(r.status) ? "retry" : r;
			} catch (e) {
				if (last || !isConnectionError(e)) throw new CsamScannerUnreachableError(e);
				return "retry";
			}
		};
		let first = await attempt(false);
		if (first === "retry") {
			await sleep(retryDelayMs ?? RETRY_DELAY_MS);
			first = await attempt(true);
		}
		const res = first as Response;

		if (res.status === 400) {
			let message: unknown;
			try {
				message = ((await res.json()) as { message?: unknown })?.message;
			} catch {
				// leave message undefined: falls through to the unreachable throw below
			}
			if (typeof message === "string" && /invalid pdq hash/i.test(message)) {
				return { status: "clean" };
			}
			throw new CsamScannerUnreachableError(`HTTP 400: ${typeof message === "string" ? message : "unrecognized body"}`);
		}
		if (!res.ok) {
			throw new CsamScannerUnreachableError(`HTTP ${res.status}`);
		}

		let body: unknown;
		try {
			body = await res.json();
		} catch (e) {
			throw new CsamScannerUnreachableError(e);
		}

		// Shape: {"pdq": {"BANK_NAME": [{"bank_content_id": N, "distance": "0"}, ...], ...}}
		const pdq = (body as { pdq?: unknown })?.pdq;
		if (!pdq || typeof pdq !== "object") return { status: "clean" };
		for (const [bankName, matches] of Object.entries(pdq as Record<string, unknown>)) {
			if (!Array.isArray(matches) || matches.length === 0) continue;
			const hit = matches[0] as { bank_content_id?: unknown; distance?: unknown };
			if (typeof hit?.bank_content_id === "number") {
				return {
					status: "match",
					bankName,
					bankContentId: hit.bank_content_id,
					distance: typeof hit.distance === "string" ? hit.distance : String(hit.distance ?? "?"),
				};
			}
		}
		return { status: "clean" };
	},
};
