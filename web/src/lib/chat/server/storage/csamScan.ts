// The known-CSAM hash check every upload path runs: the seam between the upload code and whichever
// hash-matching provider a deployment names. The provider does the hashing and matching; this module
// reads the config and picks the provider.
//
// Configuration:
// - CSAM_SCAN_BASE_URL is where the provider answers, and CSAM_SCAN_TOKEN its bearer, if it needs one.
// - CSAM_SCAN_PROVIDER names the provider (a key of providers() below), and defaults to `hma`, a
//   self-run HMA instance (csamScanHma.ts). Another provider, such as an HTTP API that takes the image or
//   its hash, is one file exporting a CsamScanProvider plus one entry in providers(), then chosen here.
//
// Three states:
// - No scanner configured (none of the three keys set): no hash check runs. The upload is accepted and
//   each file that could hold a picture logs one line saying no known-CSAM hash check ran, with no
//   user content in it. No hosted deployment has a scanner today, so this is the hosted site's state.
// - A scanner configured: every picture is checked. Unreachable fails closed
//   (CsamScannerUnreachableError, nothing stored), and a match is refused, alerted and reported.
// - Half configured (a provider or a token with no URL, or an unknown provider): every upload is refused
//   (CsamScannerUnconfiguredError), since the operator meant a check to run and it cannot.

import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";
import { hmaProvider } from "./csamScanHma";

export type CsamScanResult =
	| { status: "clean" } // the provider answered; no bank matched
	// No hash check ran: no scanner is configured, or a self-host operator set CSAM_SCAN=off. Never
	// "clean": nothing was checked.
	| { status: "unscanned"; reason: "no-scanner" | "operator-opt-out" }
	| { status: "match"; bankName: string; bankContentId: number; distance: string };

export class CsamScannerUnreachableError extends Error {
	constructor(cause: unknown) {
		super(`CSAM scan provider unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "CsamScannerUnreachableError";
		this.cause = cause;
	}
}

/**
 * One hash-matching provider. `scan` hashes and matches one image, and answers clean or match; it throws
 * CsamScannerUnreachableError for anything it cannot read as either, so the caller refuses the file.
 */
export type CsamScanProvider = {
	name: string;
	scan(
		content: Blob,
		filename: string,
		endpoint: { baseUrl: string; token: string | undefined; retryDelayMs?: number }
	): Promise<CsamScanResult>;
};

// A function, not a constant, so a provider module that imports this one never reads it half-loaded.
const providers = (): Record<string, CsamScanProvider> => ({ hma: hmaProvider });

/**
 * The one line a person sees when a file is refused because it could not be scanned: the configured
 * scanner did not answer, or its config is incomplete. Chat and My files both show it.
 */
export const UPLOAD_NOT_SCANNED_MESSAGE =
	"We couldn't check this file just now, so it wasn't added. Please try again in a minute.";

/** The scanner config is incomplete (an unknown provider, or a provider with no URL), so no file may be accepted. */
export class CsamScannerUnconfiguredError extends Error {
	constructor() {
		super("The CSAM scan config is incomplete, so uploads cannot be scanned and are refused");
		this.name = "CsamScannerUnconfiguredError";
	}
}

function configString(key: string): string | undefined {
	const v = Reflect.get(config, key);
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const warnedMisconfig = new Set<string>();
function warnMisconfigOnce(message: string): void {
	if (warnedMisconfig.has(message)) return;
	warnedMisconfig.add(message);
	logger.error(`[csam-scan] ${message}`);
}

type ScannerState =
	| { kind: "none" }
	| { kind: "incomplete" }
	| { kind: "ready"; provider: CsamScanProvider; baseUrl: string; token: string | undefined };

/** Which of the three states the config is in (see the header). */
function scannerState(): ScannerState {
	const named = configString("CSAM_SCAN_PROVIDER")?.toLowerCase();
	const baseUrl = configString("CSAM_SCAN_BASE_URL")?.replace(/\/$/, "");
	const token = configString("CSAM_SCAN_TOKEN");
	if (!named && !baseUrl && !token) return { kind: "none" };
	const name = named ?? "hma";
	const provider = providers()[name];
	if (!provider) {
		warnMisconfigOnce(`CSAM_SCAN_PROVIDER="${name}" names no known provider, so uploads are refused`);
		return { kind: "incomplete" };
	}
	if (!baseUrl) {
		warnMisconfigOnce(`the CSAM scan config names provider "${name}" or a token but has no CSAM_SCAN_BASE_URL, so uploads are refused`);
		return { kind: "incomplete" };
	}
	return { kind: "ready", provider, baseUrl, token };
}

let warnedHostedOptOut = false;

/**
 * Has a self-host operator explicitly turned the scan off (CSAM_SCAN=off)? Honoured ONLY when
 * ALPHA_EDITION is set and is not "hosted". Its effect on uploads is the same as no scanner; it also
 * stands in for the scanner keys in the self-host flag defaults (flags.ts).
 */
export function csamScanOptedOut(): boolean {
	const asked = String(Reflect.get(config, "CSAM_SCAN") ?? "").trim().toLowerCase() === "off";
	if (!asked) return false;
	const edition = String(Reflect.get(config, "ALPHA_EDITION") ?? "").trim().toLowerCase();
	if (edition === "") return false;
	if (edition === "hosted") {
		if (!warnedHostedOptOut) {
			warnedHostedOptOut = true;
			logger.error("[csam-scan] CSAM_SCAN=off is ignored on a hosted deployment");
		}
		return false;
	}
	return true;
}

/** The scan is skipped: no scanner is configured, so no hash check runs. */
export function csamScanSkipped(): boolean {
	return scannerState().kind === "none";
}

/**
 * The result for one accepted file that no hash check looked at, with the one log line saying so. The
 * line carries no user content: no file name, no account, no bytes.
 */
export function unscannedResult(): CsamScanResult {
	if (csamScanOptedOut()) {
		logger.warn("[csam-scan] no known-CSAM hash check ran: the operator set CSAM_SCAN=off");
		return { status: "unscanned", reason: "operator-opt-out" };
	}
	logger.warn("[csam-scan] no known-CSAM hash check ran: no scanner is configured");
	return { status: "unscanned", reason: "no-scanner" };
}

/**
 * Can uploads be taken at all? True with no scanner or a working scanner config; false only when the
 * config is incomplete. The attach control and every upload path read this one answer.
 */
export function csamScanAllowsUploads(): boolean {
	return scannerState().kind !== "incomplete";
}

/**
 * Hash `content` and check it against the configured provider's banks, or skip the check when no
 * scanner is configured. Throws {@link CsamScannerUnconfiguredError} when the config is incomplete,
 * and {@link CsamScannerUnreachableError} when the provider gives no answer it can read as clean or
 * match; the caller (uploadCustodialFile, parseRequest) fails the upload closed on either. This
 * function never decides that itself, so a future caller with a different risk posture isn't forced
 * to inherit this one's.
 */
export async function scanCsamHash(
	content: Blob,
	filename: string,
	opts: { retryDelayMs?: number } = {}
): Promise<CsamScanResult> {
	const state = scannerState();
	if (state.kind === "none") return unscannedResult();
	if (state.kind === "incomplete") throw new CsamScannerUnconfiguredError();
	return state.provider.scan(content, filename, {
		baseUrl: state.baseUrl,
		token: state.token,
		retryDelayMs: opts.retryDelayMs,
	});
}
