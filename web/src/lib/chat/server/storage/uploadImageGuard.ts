/**
 * The Shieldstral child-safety screen for pictures a person stores: a photo saved to My
 * files, and every picture inside a PDF or Word file saved there. It runs after the known-CSAM hash
 * check (embeddedImageScan.ts), which only catches pictures already in a bank; this one judges what a
 * new picture shows.
 *
 * Only the child-tier rules run here, two calls per picture rather than chat's fourteen. A stored file
 * is the person's own until it is sent to a model, and every chat turn that carries a picture still runs
 * the whole policy on it (prepareTurnMedia.ts). Storage providers scan stored files for CSAM and leave
 * the rest of a content policy to the point of sharing; this follows that line.
 *
 * Fails closed: a child rule that fires refuses the file, and a screen that cannot answer (unreachable,
 * past its deadline, a picture sharp cannot render, no endpoint on a hosted build) refuses it too. A
 * self-host edition with no Shieldstral endpoint stores the picture unscreened, as its chat turns go.
 */

import { createHash } from "node:crypto";
import type sharp from "sharp";
import { logger as defaultLogger } from "$lib/chat/server/logger";
import { getGuardVerdict, guardPrimaryConfigured, type GuardScreenDeps } from "$lib/chat/server/guardGate";
import { isSelfHostEdition } from "$lib/chat/server/moderation";
import { childRules, loadGuardPolicy } from "$lib/chat/server/guardPolicy";
import type { FailedUnit, GuardHit, PreparedImage } from "$lib/chat/server/guardScreenTypes";
import { screenRendition } from "$lib/chat/server/screenRendition";

/** Distinct pictures one file may hold for this screen. At two calls each that is 40 calls to the
 *  guard endpoint for one file. A file with more is refused whole; no subset is screened in its place. */
const MAX_SCREENED_IMAGES_PER_FILE = 20;

/** A child-tier rule fired on a stored picture. `hits` carries rule keys only, never bytes. */
export class ImageScreenBlockedError extends Error {
	name = "ImageScreenBlockedError";
	constructor(
		readonly category: string,
		readonly hits: GuardHit[]
	) {
		super(`stored picture refused by the child-safety screen: ${category}`);
	}
}

/** The screen could not give an answer for every picture, so the file is refused. `reason` is for
 *  logs only. A retry may succeed, unlike a block. */
export class ImageScreenUnavailableError extends Error {
	name = "ImageScreenUnavailableError";
	constructor(readonly reason: string) {
		super(`stored picture could not be screened: ${reason}`);
	}
}

/**
 * What a person reads when a file holds more pictures than the screen checks: how many it
 * has, the most we check, and the way out. A scanned document is one picture per page, so splitting
 * it is the step that works; sending it again gets the same answer.
 */
export function tooManyImagesMessage(count: number): string {
	return `This file has ${count} pictures in it, and we can check up to ${MAX_SCREENED_IMAGES_PER_FILE} in one file, so it wasn't added. Split it into smaller files of up to ${MAX_SCREENED_IMAGES_PER_FILE} pictures and add each one.`;
}

/** Too many distinct pictures in one file to screen within budget. */
export class TooManyImagesToScreenError extends Error {
	name = "TooManyImagesToScreenError";
	constructor(readonly count: number) {
		super(`file holds ${count} pictures, over the ${MAX_SCREENED_IMAGES_PER_FILE} the screen checks`);
	}
}

export type UploadImageGuardDeps = Pick<GuardScreenDeps, "judge" | "timeoutMs" | "concurrency"> & {
	sharpImpl?: typeof sharp;
	configured?: () => boolean;
	selfHost?: () => boolean;
	logger?: Pick<typeof defaultLogger, "info" | "warn" | "error">;
};

/**
 * Screen `images` (raw bytes of each distinct picture) with the child-tier rules. Resolves when every
 * picture was judged and none fired; throws one of the three errors above otherwise. Resolves without
 * a call only on a self-host edition with no Shieldstral endpoint.
 */
export async function screenStoredImages(images: Uint8Array[], deps: UploadImageGuardDeps = {}): Promise<void> {
	if (images.length === 0) return;
	const log = deps.logger ?? defaultLogger;
	if (!deps.judge && !(deps.configured ?? guardPrimaryConfigured)()) {
		// A self-host operator's choice: no picture classifier, so stored pictures go unscreened.
		if ((deps.selfHost ?? isSelfHostEdition)()) {
			log.warn("[upload-guard] self-host with GUARD_SHADOW_URL unset, so a stored picture was not screened");
			return;
		}
		// A hosted build with the address missing: a loud misconfiguration, never a silent pass.
		log.error("[upload-guard] GUARD_SHADOW_URL is unset, so a stored picture was refused");
		throw new ImageScreenUnavailableError("not configured");
	}
	const distinct = dedupe(images);
	if (distinct.length > MAX_SCREENED_IMAGES_PER_FILE) throw new TooManyImagesToScreenError(distinct.length);

	const policy = loadGuardPolicy();
	if (!policy) throw new ImageScreenUnavailableError("policy did not load");
	const childPolicy = { ...policy, entries: childRules(policy) };

	const sharpFn = deps.sharpImpl ?? (await import("sharp")).default;
	const prepared: PreparedImage[] = [];
	const failedUnits: FailedUnit[] = [];
	for (const { sha, bytes } of distinct) {
		try {
			// The rendition chat's screen uses (screenRendition.ts).
			const encoded = await screenRendition(sharpFn, bytes);
			prepared.push({
				sha,
				mime: "image/jpeg",
				source: Buffer.from(bytes),
				screenB64: encoded.toString("base64"),
				sourceMessageId: "",
				caption: "",
			});
		} catch {
			failedUnits.push({ kind: "image-encode", sha });
		}
	}

	const started = Date.now();
	const verdict = await getGuardVerdict(
		{ corpus: "", typedTurnText: "", images: prepared, failedUnits },
		{ policy: childPolicy, judge: deps.judge, timeoutMs: deps.timeoutMs, concurrency: deps.concurrency, logger: deps.logger }
	);
	log.info(
		{ images: distinct.length, failed: failedUnits.length, ms: Date.now() - started, flagged: verdict.childSafety.flagged },
		"[upload-guard] stored pictures screened"
	);
	const child = verdict.childSafety;
	if (!child.flagged) return;
	if (child.unscreened) throw new ImageScreenUnavailableError("no answer from the screen");
	throw new ImageScreenBlockedError(child.category ?? "child", verdict.hits);
}

function dedupe(images: Uint8Array[]): Array<{ sha: string; bytes: Uint8Array }> {
	const seen = new Map<string, Uint8Array>();
	for (const bytes of images) {
		const sha = createHash("sha256").update(bytes).digest("hex");
		if (!seen.has(sha)) seen.set(sha, bytes);
	}
	return [...seen].map(([sha, bytes]) => ({ sha, bytes }));
}
