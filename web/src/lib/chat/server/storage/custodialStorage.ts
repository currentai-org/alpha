// List/upload/download/delete against the shared custodial bucket
// (buckets/current-ai-official/custodial-storage-eu, in the EU region), on top of the users/<id>/
// layout and per-request ownership check (CUR-899). One shared HF_BUCKETS_TOKEN credential holds
// everyone's files, so every function here re-derives ownership from the path itself via
// assertOwnership before touching the bucket, never trusting that a path was safely constructed
// upstream (custodialBucket.ts's own stated contract, CUR-928).
//
// List, upload, download (byte-for-byte) and delete all work through @huggingface/hub with a plain
// Bearer token: no S3, no manual key mint (scripts/hf-bucket-probe.mjs checks this against the real
// bucket). listFiles's returned `path` is always the full repo-relative path regardless of the `path`
// query filter used to scope the request, which is what makes checking assertOwnership against each
// listed entry's own `path` meaningful rather than a no-op.
//
// Gated per person by custodialStorageViewEnabledForUser() (CUR-1276). Callers (routes, not this
// module) are responsible for checking the gate before reaching any function here.

import path from "node:path";
import { HubApiError, listFiles, uploadFile, downloadFile, deleteFile, type ListFileEntry } from "@huggingface/hub";
import { config } from "$lib/chat/server/config";
import { deployEnv } from "$lib/chat/server/deployEnv";
import {
	assertOwnership,
	assertOwnerOwnership,
	ownerPrefix,
	resolveOwnerPath,
	resolveUserPath,
	userPrefix,
	CUSTODIAL_QUARANTINE_DIRNAME,
	OwnershipMismatchError,
	type StorageRoot,
} from "./custodialBucket";
import { resolveUploadKind } from "$lib/chat/server/rag/extractFile";
import { SCANNER_UNREADABLE_IMAGE_MIMES } from "$lib/chat/constants/ragUpload";
import { recordRateLimitTrip, clearRateLimitTrip, recordCsamMatch } from "$lib/chat/server/alerting";
import { reportCsamMatchToCoop, reportHitToCoop } from "$lib/chat/server/moderation";
import { runInBackground } from "$lib/chat/server/vercelBackground";
import { csamScanConfigured, CsamScannerUnconfiguredError, HmaUnreachableError } from "./csamScan";
import { scanFileForCsam } from "./embeddedImageScan";
import { hubFetch } from "./hubThrottle";
import {
	memoKeyStore,
	openCustodialObject,
	ownerGrant,
	ownerRecipient,
	sealToRecipient,
	tombstoneOwnerKey,
	replaceOwnerKey,
	type Grant,
	type KeyBucket,
	type KeyStore,
	type OwnerLock,
} from "./custodialCrypto";
import { withAdvisoryLock } from "$lib/chat/server/db/advisoryLock";
import { ImageScreenBlockedError, screenStoredImages } from "./uploadImageGuard";
import {
	CUSTODIAL_ALLOWED_KINDS,
	CUSTODIAL_MAX_BYTES_PER_FILE,
	CUSTODIAL_MAX_FILES_PER_USER,
	CUSTODIAL_MAX_TOTAL_BYTES_PER_USER,
	GUEST_MAX_FILES_PER_SESSION,
	GUEST_MAX_TOTAL_BYTES_PER_SESSION,
	CUSTODIAL_RATE_WINDOW_MS,
	CUSTODIAL_UPLOADS_PER_HOUR,
} from "$lib/chat/constants/custodialUpload";

// The limits, as typed errors a route maps to a real status. Throwing beats returning a
// falsy value: an unguarded write path that fails silently is how a quota becomes a suggestion, and
// this module's callers are routes that need something to turn into a 4xx. (CUR-1129)
export class FileTooLargeError extends Error {
	constructor(
		readonly bytes: number,
		readonly limit: number = CUSTODIAL_MAX_BYTES_PER_FILE
	) {
		super(`file is ${bytes} bytes; the limit is ${limit}`);
		this.name = "FileTooLargeError";
	}
}
export class UnsupportedFileTypeError extends Error {
	constructor(readonly sniffed: string | null) {
		super(`unsupported file type${sniffed ? ` (${sniffed})` : ""}`);
		this.name = "UnsupportedFileTypeError";
	}
}
/** An image from a person the `multimodal` flag does not select (CUR-2725: team accounts only on preview). */
export class ImageInputNotAllowedError extends Error {
	name = "ImageInputNotAllowedError";
	message = "Images can't be added to your files on this deployment yet.";
}
/** A PDF or DOCX from a person the `document-attachments` flag does not select (CUR-987). Its pictures
 *  are extracted by parsers that run in this process, which is acceptable for team accounts only
 *  until the sandboxed parser lands (CUR-2780); storing it unscanned is not an option. */
export class DocumentInputNotAllowedError extends Error {
	name = "DocumentInputNotAllowedError";
	message = "PDF and Word files can't be added to your files on this deployment yet.";
}
export class StorageQuotaExceededError extends Error {
	constructor(
		readonly usedBytes: number,
		readonly fileCount: number
	) {
		super(`quota exceeded: ${fileCount} files, ${usedBytes} bytes stored`);
		this.name = "StorageQuotaExceededError";
	}
}
export class UploadRateLimitedError extends Error {
	constructor(readonly retryAfterMs: number) {
		super(`too many uploads; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
		this.name = "UploadRateLimitedError";
	}
}
// Thrown after the upload has already been redirected to quarantine — never after a write to
// the caller's real path, since the scan runs before that write (see uploadCustodialFile below). (CUR-1136)
export class CsamMatchError extends Error {
	constructor() {
		super("upload rejected");
		this.name = "CsamMatchError";
	}
}

// Per-instance, in-memory, best-effort — the same shape and the same caveat as betterAuth.ts's OTP
// limiter. A serverless fan-out gives each instance its own empty Map, so this bounds one runaway
// client, not a distributed attack. It is a civility limit; the quota checks below are the ones that
// actually bound storage, and they read the real bucket rather than a counter that can drift.
const uploadTimes = new Map<string, number[]>();

// Bytes this instance has admitted but not yet finished writing. The quota below reads the bucket,
// and a listing cannot see an upload that is still in flight — so two uploads racing (a picker
// submitting several files at once, or a retry overtaking its original) would both measure the same
// pre-upload total and both be admitted. Counting in-flight bytes closes that for callers sharing a
// process, which is the case that actually happens.
const inFlightBytes = new Map<string, number>();

// Upload has a hard cap and a 4xx on trip, but a 4xx reaches only the person who
// tripped it — the team learns nothing about who's hitting it or how often. download/
// deleteCustodialFile have no cap, so their velocity is tracked here purely to alert on, never to
// block. Same in-memory/per-instance shape and the same caveat as
// uploadTimes above: a civility-scale signal, not a distributed one. (CUR-1135)
const downloadTimes = new Map<string, number[]>();
const deleteTimes = new Map<string, number[]>();
// Deliberately not in custodialUpload.ts: that file is shared with the client for UX feedback on a
// real limit, and download/delete have no limit here to show — this is a server-only alert trigger.
// Exported for the test file only; nothing in the app imports these outside this module.
export const CUSTODIAL_DOWNLOAD_VELOCITY_ALERT_PER_HOUR = 120;
export const CUSTODIAL_DELETE_VELOCITY_ALERT_PER_HOUR = 100;

/** Record one call and return how many fall inside the rolling window, including this one. Shared by
 *  the upload rate limiter and the download/delete velocity trackers below — the only difference
 *  between them is what happens once the count is known (throw vs alert-only). */
function recordAndCount(times: Map<string, number[]>, sessionUserId: string, now: number): number {
	const cutoff = now - CUSTODIAL_RATE_WINDOW_MS;
	const recent = (times.get(sessionUserId) ?? []).filter((t) => t > cutoff);
	recent.push(now);
	times.set(sessionUserId, recent);
	return recent.length;
}

function assertUploadRateOk(sessionUserId: string, now = Date.now()): void {
	const cutoff = now - CUSTODIAL_RATE_WINDOW_MS;
	const recent = (uploadTimes.get(sessionUserId) ?? []).filter((t) => t > cutoff);
	if (recent.length >= CUSTODIAL_UPLOADS_PER_HOUR) {
		// fire-and-forget, same posture as CUR-1134's chat rate limiter — alerting on abuse
		// must never add latency to (or block) the 429 already being thrown. sessionUserId is the
		// opaque account id requireStorageAccess resolves (guard.ts), never a raw IP or email. (CUR-1135)
		void recordRateLimitTrip(`custodial-storage:upload-rate:${sessionUserId}`, {
			limitName: "custodial upload rate (per hour)",
			identity: sessionUserId,
		});
		throw new UploadRateLimitedError(recent[0] + CUSTODIAL_RATE_WINDOW_MS - now);
	}
	recent.push(now);
	uploadTimes.set(sessionUserId, recent);
}

/** Alert-only — never throws, never blocks the caller. Called before the real operation, so it
 *  counts attempts rather than successes; a burst of failing calls still alerts even though
 *  nothing here can 429 it. */
function noteDownloadVelocity(sessionUserId: string, now = Date.now()): void {
	const count = recordAndCount(downloadTimes, sessionUserId, now);
	if (count > CUSTODIAL_DOWNLOAD_VELOCITY_ALERT_PER_HOUR) {
		void recordRateLimitTrip(`custodial-storage:download-velocity:${sessionUserId}`, {
			limitName: "custodial download velocity (per hour)",
			identity: `${sessionUserId} (${count}/hr)`,
		});
	}
}

function noteDeleteVelocity(sessionUserId: string, now = Date.now()): void {
	const count = recordAndCount(deleteTimes, sessionUserId, now);
	if (count > CUSTODIAL_DELETE_VELOCITY_ALERT_PER_HOUR) {
		void recordRateLimitTrip(`custodial-storage:delete-velocity:${sessionUserId}`, {
			limitName: "custodial delete velocity (per hour)",
			identity: `${sessionUserId} (${count}/hr)`,
		});
	}
}

/** Production's bucket, in Hugging Face's EU region (CUR-4533), and the one a production deployment gets when
 * `HF_BUCKETS_REPO` is unset. */
const DEFAULT_CUSTODIAL_BUCKET_REPO = "buckets/current-ai-official/custodial-storage-eu";

/** A deployment that isn't production has no `HF_BUCKETS_REPO` (CUR-4114). It refuses storage
 *  rather than read and write production's bucket under whatever token it holds. */
class CustodialBucketUnsetError extends Error {
	constructor(env: string | null) {
		super(
			`HF_BUCKETS_REPO is not set on this ${env ?? "undeclared"} deployment; only production may use ` +
				`${DEFAULT_CUSTODIAL_BUCKET_REPO} by default, so custodial storage is refused`
		);
		this.name = "CustodialBucketUnsetError";
	}
}

const BUCKET_REPO_SHAPE = /^buckets\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/** The one bucket this deployment talks to. Set per environment so preview and production hold
 * their files in different buckets under different tokens (CUR-1288). Not user-configurable: CUR-413
 * (a user's OWN external bucket) is separate work with its own credential model. A malformed value
 * throws rather than falling back, since silently writing to the production bucket from a preview is
 * the failure this setting exists to prevent. */
function custodialBucketRepo(): string {
	const configured = config.HF_BUCKETS_REPO?.trim();
	if (!configured) {
		// Production's name is the default only on production. Anywhere else a forgotten setting
		// would share production's files with that deployment, so it fails by name (CUR-4114).
		const env = deployEnv();
		if (env === "production") return DEFAULT_CUSTODIAL_BUCKET_REPO;
		throw new CustodialBucketUnsetError(env);
	}
	if (!BUCKET_REPO_SHAPE.test(configured)) {
		throw new Error(`HF_BUCKETS_REPO must look like buckets/<owner>/<name>, got ${JSON.stringify(configured)}`);
	}
	return configured;
}

function bucketAccessToken(): string {
	const token = config.HF_BUCKETS_TOKEN;
	if (!token) {
		throw new Error("HF_BUCKETS_TOKEN is not configured — custodial storage cannot authenticate");
	}
	return token;
}

/** What every Hub call here passes: the storage token, and the fetch that tracks its rate limit (CUR-3680). */
function hubAuth(): { accessToken: string; fetch: typeof fetch } {
	return { accessToken: bucketAccessToken(), fetch: hubFetch };
}

/** Owners' key objects and recipients, in the same bucket as their files (CUR-4115, CUR-4116). */
const bucketKeys: KeyBucket = {
	async read(keyPath) {
		const blob = await downloadFile({ repo: custodialBucketRepo(), path: keyPath, ...hubAuth() });
		return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
	},
	async write(keyPath, bytes) {
		await uploadFile({ repo: custodialBucketRepo(), file: { path: keyPath, content: new Blob([bytes as BlobPart]) }, ...hubAuth() });
	},
	async uploadedAt(objectPath) {
		// Listing one exact path returns that file alone, with the bucket's upload time.
		for await (const entry of listFiles({ repo: custodialBucketRepo(), path: objectPath, ...hubAuth() })) {
			if (entry.type === "file" && entry.path === objectPath && entry.uploadedAt) return Date.parse(entry.uploadedAt);
		}
		return null;
	},
};

/** The key store one chat turn passes to every attachment read it makes, so several of one owner's
 *  files cost one key read (CUR-4116). Make one per turn and drop it with the turn: one kept longer
 *  would not see a wipe's tombstone. */
export function turnKeyStore(): KeyStore {
	return memoKeyStore(bucketKeys);
}

/** Read one owner's object and open it (CUR-4115): sealed objects decrypt, legacy plaintext passes
 *  through, and a sealed object that won't open throws CustodialCryptoError. */
async function readOpened(grant: Grant, bucketPath: string, keys: KeyStore = bucketKeys): Promise<Blob | null> {
	const blob = await downloadFile({ repo: custodialBucketRepo(), path: bucketPath, ...hubAuth() });
	return blob ? openCustodialObject(grant, bucketPath, blob, keys) : null;
}

/** Whether writes on this deployment are sealed (CUR-4116). A deployment switch, not a flag: every
 *  owner's files must be sealed or not together, and a person cannot be rolled out to one at a time. */
function sealWritesOn(): boolean {
	return config.CUSTODIAL_SEAL_WRITES?.trim() === "true";
}

/** The bytes a write stores for this owner: an age file to their recipient while sealing is on, the
 *  content unchanged while it is off. The owner's key is made on their first sealed write.
 *  @throws CustodialCryptoError key_tombstoned for a wiped owner, master_missing with no master. */
async function sealedForWrite(owner: Owner, content: Blob): Promise<Blob> {
	if (!sealWritesOn()) return content;
	const recipient = await ownerRecipient(ownerGrant(owner.root, owner.id), bucketKeys, withAdvisoryLock);
	return new Blob([(await sealToRecipient(recipient, new Uint8Array(await content.arrayBuffer()))) as BlobPart]);
}

/** Whether this deployment has a bucket at all. False means there is nothing to list, which is a
 * different fact from an empty listing. */
export function custodialStorageConfigured(): boolean {
	return Boolean(config.HF_BUCKETS_TOKEN);
}

/** Where walkthrough recordings live in the bucket (CUR-2183), at the root beside users/
 * and never under any person's folder. Same string as journeyGallery.ts's VIDEO_PREFIX. */
const JOURNEY_RECORDINGS_PREFIX = "journey-gallery/";

/** One walkthrough recording, read from the bucket. Only paths that normalise to somewhere
 * under journey-gallery/ are read, so this can never return a person's file whatever it is asked
 * for. The admin check is the route's job.
 * @returns null when there is no such recording, or no bucket on this deployment. */
export async function readJourneyRecording(filename: string): Promise<Blob | null> {
	if (!custodialStorageConfigured()) return null;
	const normalized = path.posix.normalize(filename);
	if (!normalized.startsWith(JOURNEY_RECORDINGS_PREFIX) || normalized !== filename) return null;
	// Not through readOpened: recordings belong to no owner and stay plaintext until they move to a
	// bucket of their own (docs/plans/custodial-file-encryption.md, "The seam").
	return downloadFile({
		repo: custodialBucketRepo(),
		path: normalized,
		...hubAuth(),
	});
}

/** Every file under the session user's own users/<id>/ folder. Non-file entries (directories) are
 * dropped — a storage-view listing wants leaves, not the tree shape. */
export async function listCustodialFiles(sessionUserId: string): Promise<ListFileEntry[]> {
	return listOwnerFiles({ root: "users", id: sessionUserId });
}

/** One owner of files in the bucket: a signed-in person, or a guest's session (CUR-2183). */
type Owner = { root: StorageRoot; id: string };

/** The key the per-instance rate and in-flight maps use. A guest's is prefixed so a session id can
 * never share a counter with an account id. */
const ownerKey = (owner: Owner) => (owner.root === "users" ? owner.id : `guest:${owner.id}`);

/**
 * The folder inside a conversation's attachment folder that holds its long pastes (CUR-2183). A paste
 * is message text the composer sent as a file (CUR-1895), so it is kept for the turns that read it
 * but is not a file the person gave Alpha: it stays out of My files and out of the quota. Never a
 * sha, so it cannot collide with an attachment's `<sha>/` folder, and the My files upload route
 * cannot write here (it takes a named subfolder and a bare filename).
 */
export const PASTES_DIRNAME = "pastes";

/** Whether a path relative to the owner's prefix is a stored paste. */
const isPastePath = (relative: string) => new RegExp(`^conversations/[^/]+/${PASTES_DIRNAME}/`).test(relative);

async function listOwnerFiles(owner: Owner, opts: { includePastes?: boolean } = {}): Promise<ListFileEntry[]> {
	const prefix = ownerPrefix(owner.root, owner.id); // throws InvalidUserIdError first, same as every entry point below
	const entries: ListFileEntry[] = [];
	for await (const entry of listFiles({
		repo: custodialBucketRepo(),
		path: prefix,
		recursive: true,
		...hubAuth(),
	})) {
		if (entry.type !== "file") continue;
		// Defense in depth, per assertOwnership's own contract: don't trust that the `path` query
		// filter above actually scoped correctly — re-derive ownership from each entry's own path.
		assertOwnerOwnership(owner.root, owner.id, entry.path);
		// A quarantined file is never a listing result — mirrors agent-service's own
		// ARTIFACT_QUARANTINE_DIRNAME exclusion from its artifact listing (CUR-836). (CUR-1136)
		if (entry.path.startsWith(`${prefix}${CUSTODIAL_QUARANTINE_DIRNAME}/`)) continue;
		if (!opts.includePastes && isPastePath(entry.path.slice(prefix.length))) continue;
		entries.push(entry);
	}
	return entries;
}

// Listing the owner's whole tree on every upload would cost one call each on the shared
// storage token. A listing is kept here for a minute per owner, with this instance's own writes added
// and any delete through this module dropping it. Another instance's writes stay unseen until the
// minute is up, so racing instances can overshoot by what they each admit in that minute: still bounded by the per-instance upload rate above, and a
// refusal is only ever made on a fresh listing (writeWithinQuota), so a stale count never says no. (CUR-3682)
const QUOTA_LISTING_TTL_MS = 60_000;
const quotaListings = new Map<string, { at: number; entries: ListFileEntry[] }>();

/** The owner's listing, and whether it is a kept one rather than read from the bucket just now. */
async function quotaListing(owner: Owner, opts: { fresh?: boolean } = {}): Promise<{ entries: ListFileEntry[]; kept: boolean }> {
	const key = ownerKey(owner);
	const kept = quotaListings.get(key);
	if (!opts.fresh && kept && Date.now() - kept.at < QUOTA_LISTING_TTL_MS) return { entries: kept.entries, kept: true };
	const entries = await listOwnerFiles(owner);
	quotaListings.set(key, { at: Date.now(), entries });
	return { entries, kept: false };
}

/** Adds a write this instance just finished to the owner's kept listing, replacing a file at that path. */
function noteQuotaWrite(owner: Owner, path: string, size: number): void {
	const kept = quotaListings.get(ownerKey(owner));
	if (!kept) return;
	const entries = kept.entries.filter((e) => e.path !== path);
	entries.push({ type: "file", path, size, oid: "", uploadedAt: new Date().toISOString() } as ListFileEntry);
	quotaListings.set(ownerKey(owner), { at: kept.at, entries });
}

const forgetQuotaListing = (owner: Owner) => quotaListings.delete(ownerKey(owner));

/** Uploads to `relativePath` inside the session user's own folder (traversal-checked by
 * resolveUserPath). `content` is the file's raw bytes — the caller decides Blob vs File vs a
 * server-side read; this module has no opinion on where the bytes came from. */
export type UploadOptions = {
	// The per-file ceiling for this upload. A chunked upload passes the larger chunked limit;
	// omitted means the single-request one. (CUR-1780)
	maxBytes?: number;
	// The `csam_scanner_down` fault (preview only, see faultInjection.ts) makes the scan
	// fail the way a dead HMA does, so a spec can read the refusal on a live deployment. (CUR-2382)
	scannerDown?: boolean;
	// False refuses an image before it is scanned or stored. The route a person uploads
	// through passes the `multimodal` flag for their account; omitted means allowed, for callers whose
	// images were already gated (a chat attachment, which parseRequest refused unless the flag allows). (CUR-2725)
	imagesAllowed?: boolean;
	// False refuses a PDF or DOCX before any parser opens it. The route passes the
	// `document-attachments` flag for the account; omitted means allowed, for a chat attachment that
	// parseRequest already gated the same way. (CUR-987)
	documentsAllowed?: boolean;
};

/**
 * The screening a write to a person's own linked bucket gets, identical to an upload into
 * Alpha storage minus the quota (their bucket, their quota). Call it before the write, never after. (CUR-2930)
 */
export async function screenUploadForUser(
	userId: string,
	fileName: string,
	content: Blob,
	opts: UploadOptions = {}
): Promise<void> {
	return screenUpload({ root: "users", id: userId }, fileName, content, opts);
}

export async function uploadCustodialFile(
	sessionUserId: string,
	relativePath: string,
	content: Blob,
	opts: UploadOptions = {}
): Promise<void> {
	return uploadForOwner({ root: "users", id: sessionUserId }, relativePath, content, opts, {
		maxFiles: CUSTODIAL_MAX_FILES_PER_USER,
		maxTotalBytes: CUSTODIAL_MAX_TOTAL_BYTES_PER_USER,
	});
}

/**
 * Every check a file passes before any bucket write, whichever location it is headed for: size, the
 * hourly upload rate, the type sniffed from its bytes, the per-account image and document flags, and
 * the CSAM scan. A match is written to the owner's quarantine folder in OUR bucket and then refused,
 * so the evidence stays where a reviewer can find it even when the person was writing to a bucket of
 * their own (CUR-2930). Throws the same typed errors guard.ts maps to statuses.
 */
async function screenUpload(owner: Owner, relativePath: string, content: Blob, opts: UploadOptions): Promise<void> {
	const sessionUserId = ownerKey(owner);
	// CUR-1129, in cost order: the two free checks first, then the one that costs a listing.
	const maxBytes = opts.maxBytes ?? CUSTODIAL_MAX_BYTES_PER_FILE;
	if (content.size > maxBytes) throw new FileTooLargeError(content.size, maxBytes);
	assertUploadRateOk(sessionUserId);

	// Type comes from the bytes, never the filename — an extension is a claim the uploader controls.
	// Only the header is read, so this does not pull the whole file into memory to classify it.
	const header = new Uint8Array(await content.slice(0, 4100).arrayBuffer());
	const kind = await resolveUploadKind({
		bytes: header,
		name: relativePath,
		declaredMime: content.type || undefined,
	});
	if (!kind || !CUSTODIAL_ALLOWED_KINDS.includes(kind)) {
		throw new UnsupportedFileTypeError(kind);
	}
	// Decided from the sniffed bytes, like the type check above, so a renamed image is still an image.
	if (kind === "image" && opts.imagesAllowed === false) throw new ImageInputNotAllowedError();
	// The scanner cannot hash a HEIC and answers 500, which would read as an outage and tell
	// the person to try again forever. Refuse it as a type instead; My files converts one to JPEG first. (CUR-4665)
	if (kind === "image") {
		const sniffed = await sniffMime(header);
		if (sniffed && SCANNER_UNREADABLE_IMAGE_MIMES.includes(sniffed)) throw new UnsupportedFileTypeError(sniffed);
	}

	// Scan before the real write, not after (CUR-1136): HmaUnreachableError propagates straight out of
	// this function (fail closed: no bytes reach the bucket at all), and a match is redirected to
	// quarantine instead of the caller's real path, so a matched upload never lands where a normal
	// listing or download could reach it.
	//
	// No scanner configured refuses every file, whatever its kind (CUR-2382). A photo is scanned as
	// itself and a PDF or DOCX by every picture inside it; a text file has none (CUR-987).
	// UnscannableFileError (a picture we cannot decode) propagates like the scanner being down.
	if (!csamScanConfigured()) throw new CsamScannerUnconfiguredError();
	const scanTarget = kind === "image" || kind === "pdf" ? kind : kind === "docx" ? "office" : null;
	if ((scanTarget === "pdf" || scanTarget === "office") && opts.documentsAllowed === false) {
		throw new DocumentInputNotAllowedError();
	}
	if (scanTarget && opts.scannerDown) {
		throw new HmaUnreachableError(new Error("fault injection: csam_scanner_down"));
	}
	const collected: Buffer[] = [];
	const scanResult = await scanFileForCsam(content, relativePath, scanTarget, { collected });
	const quarantine = async () => {
		const quarantinePath = `${ownerPrefix(owner.root, owner.id)}${CUSTODIAL_QUARANTINE_DIRNAME}/${Date.now()}-${relativePath.split("/").pop()}`;
		await uploadFile({
			repo: custodialBucketRepo(),
			file: { path: quarantinePath, content },
			...hubAuth(),
		});
		return quarantinePath;
	};
	if (scanResult.status === "match") {
		const quarantinePath = await quarantine();
		// Chat's upload guard files the same alert and report (parseRequest.ts); the quarantined copy is
		// the one real item a reviewer can find. In runInBackground because the 422 ends the request, and
		// a bare `void` freezes with it on Vercel before the Coop POST leaves.
		void runInBackground(
			Promise.all([
				recordCsamMatch(sessionUserId, {
					bankName: scanResult.bankName,
					bankContentId: scanResult.bankContentId,
					distance: scanResult.distance,
				}),
				reportCsamMatchToCoop({
					reportedItemId: quarantinePath,
					bankName: scanResult.bankName,
					bankContentId: scanResult.bankContentId,
					distance: scanResult.distance,
				}),
			])
		);
		throw new CsamMatchError();
	}

	// The hash check above only knows pictures already in a bank. Shieldstral's child-tier
	// rules judge what a new picture shows. ImageScreenUnavailableError and TooManyImagesToScreenError
	// propagate and refuse the file, like the hash scanner being down. (CUR-3201)
	const pictures = scanTarget === "image" ? [new Uint8Array(await content.arrayBuffer())] : collected;
	try {
		await screenStoredImages(pictures);
	} catch (e) {
		if (!(e instanceof ImageScreenBlockedError)) throw e;
		const quarantinePath = await quarantine();
		void runInBackground(
			reportHitToCoop({
				surface: "storage-upload",
				messageId: quarantinePath,
				// Coop's item type refuses a report with no text, and no bytes ever leave us.
				text: `Child-safety screen refused a picture saved to storage (${e.category}). No file content is forwarded.`,
				hits: e.hits,
				subjectId: sessionUserId,
			})
		);
		throw new CsamMatchError();
	}
}

/** The mime file-type reads from a file's first bytes, or undefined when it recognises none. */
async function sniffMime(header: Uint8Array): Promise<string | undefined> {
	try {
		const { fileTypeFromBuffer } = await import("file-type");
		return (await fileTypeFromBuffer(header))?.mime;
	} catch {
		return undefined;
	}
}

async function uploadForOwner(
	owner: Owner,
	relativePath: string,
	content: Blob,
	opts: UploadOptions,
	limits: { maxFiles: number; maxTotalBytes: number }
): Promise<void> {
	const bucketPath = resolveOwnerPath(owner.root, owner.id, relativePath); // throws PathEscapesUserPrefixError
	assertOwnerOwnership(owner.root, owner.id, bucketPath);

	await screenUpload(owner, relativePath, content, opts);
	await writeWithinQuota(owner, bucketPath, content, limits);
}

/** The quota each kind of owner gets. */
const ownerLimits = (owner: Owner) =>
	owner.root === "users"
		? { maxFiles: CUSTODIAL_MAX_FILES_PER_USER, maxTotalBytes: CUSTODIAL_MAX_TOTAL_BYTES_PER_USER }
		: { maxFiles: GUEST_MAX_FILES_PER_SESSION, maxTotalBytes: GUEST_MAX_TOTAL_BYTES_PER_SESSION };

/**
 * A chat attachment, written as the turn's only stored copy. parseRequest has already run
 * chat's own checks on these bytes (the request cap, the type and document gates, the CSAM scan), so
 * they are not repeated here: a second scan doubles the scanner's load for nothing, and My files' type
 * list and hourly rate belong to a store a stranger fills by hand, where chat's own limits bound a
 * turn. The quota still applies, because the file shows in My files. A paste (PASTES_DIRNAME) doesn't
 * show there and doesn't count. A file already at the path (the same attachment sent again) is left as
 * it is and not counted twice.
 * @throws StorageQuotaExceededError when it does not fit, or the Hub's own error (hubRateLimitedUrl). (CUR-2183)
 */
export async function storeChatAttachment(
	owner: { userId: string } | { guestSessionId: string },
	relativePath: string,
	content: Blob,
	opts: { signal?: AbortSignal } = {}
): Promise<void> {
	const o: Owner =
		"userId" in owner ? { root: "users", id: owner.userId } : { root: "guests", id: owner.guestSessionId };
	const bucketPath = resolveOwnerPath(o.root, o.id, relativePath); // throws PathEscapesUserPrefixError
	assertOwnerOwnership(o.root, o.id, bucketPath);
	if (isPastePath(relativePath)) {
		await uploadFile({
			repo: custodialBucketRepo(),
			file: { path: bucketPath, content: await sealedForWrite(o, content) },
			...hubAuth(),
			abortSignal: opts.signal,
		});
		return;
	}
	await writeWithinQuota(o, bucketPath, content, ownerLimits(o), { skipIfStored: true, signal: opts.signal });
}

async function writeWithinQuota(
	owner: Owner,
	bucketPath: string,
	content: Blob,
	limits: { maxFiles: number; maxTotalBytes: number },
	opts: { skipIfStored?: boolean; signal?: AbortSignal } = {}
): Promise<void> {
	const sessionUserId = ownerKey(owner);
	// Sealed first, so the quota counts what the bucket will hold.
	content = await sealedForWrite(owner, content);
	// Quota measured from the real bucket rather than a stored counter: a counter drifts the moment a
	// delete, a failed upload or a second instance touches it, and a quota that drifts open is not a
	// quota. The listing is reused for up to a minute (quotaListing above, CUR-3682).
	//
	// WHAT THIS IS AND IS NOT. Read-then-write, so it is optimistic, not transactional — HF buckets
	// offer no compare-and-set to make it otherwise. In-flight bytes (above) close the same-process
	// race, which covers the case that actually occurs: one person's client firing several uploads at
	// once. What remains is two SERVERLESS INSTANCES admitting concurrently against the same listing,
	// and the overshoot that allows is bounded — at most one extra file per racing instance, so
	// concurrency x CUSTODIAL_MAX_BYTES_PER_FILE, against a quota three orders of magnitude larger.
	// Calling that a hard guarantee would be the same overclaim the rate limiter above deliberately
	// avoids; it is a bound that holds under real use and leaks slightly under a deliberate race.
	const measure = (entries: ListFileEntry[]) => {
		const usedBytes = entries.reduce((sum, e) => sum + (e.size ?? 0), 0) + (inFlightBytes.get(sessionUserId) ?? 0);
		return { usedBytes, over: entries.length >= limits.maxFiles || usedBytes + content.size > limits.maxTotalBytes };
	};
	const listing = await quotaListing(owner);
	let existing = listing.entries;
	let { usedBytes, over } = measure(existing);
	// Never refuse, and never skip as already stored, on a kept listing (CUR-3682): another instance may
	// have deleted files since, making room or removing the very file a skip would rely on.
	if (listing.kept && (over || (opts.skipIfStored && existing.some((e) => e.path === bucketPath)))) {
		existing = (await quotaListing(owner, { fresh: true })).entries;
		({ usedBytes, over } = measure(existing));
	}
	// A caller that gave up during the listing (CUR-2183's write deadline) gets no upload: the file
	// already went to the files table, and a late copy here would be a second, unreferenced one.
	opts.signal?.throwIfAborted();
	if (opts.skipIfStored && existing.some((e) => e.path === bucketPath)) return;
	if (over) {
		// Own key from the rate limiter above — a person hitting their storage quota and a
		// person hitting the hourly upload rate are different abusive patterns and should debounce
		// independently rather than share one alert. (CUR-1135)
		void recordRateLimitTrip(`custodial-storage:quota:${sessionUserId}`, {
			limitName: "custodial storage quota",
			identity: `${sessionUserId} (${existing.length} files, ${usedBytes} bytes)`,
		});
		throw new StorageQuotaExceededError(usedBytes, existing.length);
	}
	inFlightBytes.set(sessionUserId, (inFlightBytes.get(sessionUserId) ?? 0) + content.size);
	try {
		await uploadFile({
			repo: custodialBucketRepo(),
			file: { path: bucketPath, content },
			...hubAuth(),
			abortSignal: opts.signal,
		});
		noteQuotaWrite(owner, bucketPath, content.size);
		// Only once the write has actually SUCCEEDED — passing the quota check above proves
		// this session was under quota at read time, but a failed upload after that proves nothing
		// about whether the condition genuinely resolved, and clearing here regardless would let a
		// person who keeps failing (not succeeding) look "recovered". Clear any prior quota trip so a
		// future one starts a fresh episode instead of continuing to climb a counter that (unlike the
		// rate-limiter triggers above) has no time-based decay of its own. (CUR-1318)
		void clearRateLimitTrip(`custodial-storage:quota:${sessionUserId}`);
	} finally {
		// Released whether the write succeeded or threw — a failed upload that kept its reservation
		// would shrink the person's quota permanently, for free, from their point of view.
		const left = (inFlightBytes.get(sessionUserId) ?? 0) - content.size;
		if (left > 0) inFlightBytes.set(sessionUserId, left);
		else inFlightBytes.delete(sessionUserId);
	}
}

// A quarantine path is deterministic and guessable BY THE VERY PERSON quarantine exists to
// stop — `{Date.now()}-{their own filename}`, at an upload time they know and rejected synchronously
// at upload (CsamMatchError). assertOwnership alone doesn't catch this: it only checks the path
// resolves under the caller's own users/<id>/ prefix, and quarantine/ is still inside that prefix.
// Reuses OwnershipMismatchError (same "not yours" 403, no extra mapping needed in guard.ts) rather
// than a distinct error — same non-distinguishing posture assertOwnership's own header argues for. (CUR-1136)
// Tested on the NORMALIZED path, as assertOwnership is. A raw `startsWith` would let
// `users/<me>/x/../quarantine/<ts>-<name>` through, and @huggingface/hub puts the path into a URL
// unencoded, where URL parsing collapses the dot segment back onto the quarantined object. (CUR-3180)
function assertNotQuarantined(sessionUserId: string, bucketPath: string): void {
	if (path.posix.normalize(bucketPath).startsWith(`${userPrefix(sessionUserId)}${CUSTODIAL_QUARANTINE_DIRNAME}/`)) {
		throw new OwnershipMismatchError(sessionUserId, bucketPath);
	}
}

/** `bucketPath` is a full repo-relative path — typically one returned by listCustodialFiles, not
 * something to build by hand. Re-verifies ownership regardless of where it came from.
 * @returns null when the file doesn't exist, matching @huggingface/hub's own downloadFile contract. */
export async function downloadCustodialFile(sessionUserId: string, bucketPath: string): Promise<Blob | null> {
	assertOwnership(sessionUserId, bucketPath);
	assertNotQuarantined(sessionUserId, bucketPath);
	noteDownloadVelocity(sessionUserId);
	return readOpened(ownerGrant("users", sessionUserId), bucketPath);
}

/** Thrown when an account wipe could not remove every file under the person's prefix. */
export class CustodialWipeError extends Error {
	constructor(
		readonly deleted: number,
		readonly failed: number,
		cause: unknown
	) {
		super(`custodial storage wipe incomplete: ${failed} file(s) could not be deleted (${deleted} were)`, { cause });
		this.name = "CustodialWipeError";
	}
}

/**
 * Account deletion's reach into the bucket: every file under `users/<id>/`, deleted.
 *
 * @returns the number of files deleted, or `undefined` when custodial storage is not configured on
 * this deployment (no HF_BUCKETS_TOKEN). There is then no bucket to hold anything, which is a
 * different fact from "held nothing", so it is not reported as zero.
 * @throws CustodialWipeError when storage IS configured and the listing or any delete fails. The
 * caller must not report the account as cleared in that case.
 *
 * Deliberately not gated on custodialStorageViewEnabledForUser: a person may have uploaded while the
 * flag was on for them and lost it since, and their files are still theirs to have deleted.
 * Quarantined uploads (CUR-1136) are excluded by listCustodialFiles and kept: they are CSAM-match
 * evidence, retained on the same Art. 17(3) basis as child-safety `safety_events`.
 */
export async function wipeCustodialFiles(
	userId: string,
	opts: { keepAccount?: boolean; timing?: Record<string, number> } = {}
): Promise<number | undefined> {
	if (!custodialStorageConfigured()) return undefined;
	const t = opts.timing ?? {};
	let mark = Date.now();
	const step = (name: string) => {
		const now = Date.now();
		t[name] = now - mark;
		mark = now;
	};
	// The key goes before any object (CUR-4117): from here a sealed file left behind by a failed delete,
	// or in a backup, cannot be opened, and a turn still writing for this account is refused.
	try {
		await tombstoneOwnerKey(ownerGrant("users", userId), bucketKeys, timedLock(t, "tombstone"));
	} catch (e) {
		throw new CustodialWipeError(0, 0, e);
	}
	step("tombstoneMs");
	let entries: ListFileEntry[];
	try {
		// Pastes too: My files leaves them out, but account deletion must not leave pasted text behind.
		entries = await listOwnerFiles({ root: "users", id: userId }, { includePastes: true });
	} catch (e) {
		throw new CustodialWipeError(0, 0, e);
	}
	step("listMs");
	t.files = entries.length;
	forgetQuotaListing({ root: "users", id: userId });
	const deleted = await deleteAllOrThrow(entries.map((e) => e.path));
	step("deleteMs");
	// "Forget everything" keeps the account, which must be able to upload again, so it gets a
	// new key once every file is gone. A failed delete has already thrown, leaving the tombstone in place
	// until the person retries. Account deletion keeps the tombstone for good (CUR-4117). (CUR-4415)
	if (opts.keepAccount) {
		try {
			await replaceOwnerKey(ownerGrant("users", userId), bucketKeys, timedLock(t, "replace"));
		} catch (e) {
			throw new CustodialWipeError(deleted, 0, e);
		}
		step("replaceMs");
	}
	return deleted;
}

/** The advisory lock, recording into `t` how long `<label>LockWaitMs` it took to get (a database
 *  connection, then the lock) and `<label>LockHeldMs` it was held (CUR-4548). The two are what tell a
 *  slow wipe that queued behind other requests from one whose bucket calls were slow. */
function timedLock(t: Record<string, number>, label: string): OwnerLock {
	return (name, fn) => {
		const asked = Date.now();
		return withAdvisoryLock(name, async () => {
			const got = Date.now();
			t[`${label}LockWaitMs`] = got - asked;
			try {
				return await fn();
			} finally {
				t[`${label}LockHeldMs`] = Date.now() - got;
			}
		});
	};
}

/** Deletes every path, carrying on past failures, then throws CustodialWipeError if any failed. */
async function deleteAllOrThrow(paths: string[]): Promise<number> {
	let deleted = 0;
	const errors: unknown[] = [];
	for (const p of paths) {
		try {
			await deleteFile({ repo: custodialBucketRepo(), path: p, ...hubAuth() });
			deleted++;
		} catch (e) {
			errors.push(e);
		}
	}
	if (errors.length > 0) throw new CustodialWipeError(deleted, errors.length, errors[0]);
	return deleted;
}

/** Same `bucketPath` contract as downloadCustodialFile. */
export async function deleteCustodialFile(sessionUserId: string, bucketPath: string): Promise<void> {
	assertOwnership(sessionUserId, bucketPath);
	assertNotQuarantined(sessionUserId, bucketPath);
	noteDeleteVelocity(sessionUserId);
	forgetQuotaListing({ root: "users", id: sessionUserId });
	await deleteFile({
		repo: custodialBucketRepo(),
		path: bucketPath,
		...hubAuth(),
	});
}

/**
 * One chat attachment, read back for a turn that sends it to the model again.
 *
 * Not downloadCustodialFile, because that counts toward the download-velocity alert, which watches a
 * person pulling files out of their store. This is the server re-reading the person's own attachment
 * once per turn, and a long image conversation would otherwise page as an exfiltration. (CUR-2183)
 * @returns null when the file doesn't exist. */
export async function readCustodialAttachment(userId: string, relativePath: string, keys?: KeyStore): Promise<Blob | null> {
	const bucketPath = resolveUserPath(userId, relativePath);
	assertOwnership(userId, bucketPath);
	assertNotQuarantined(userId, bucketPath);
	return readOpened(ownerGrant("users", userId), bucketPath, keys);
}

/**
 * A guest's attachments, moved to the account that signed in from that session. Each file
 * is copied to the same relative path under `users/<id>/` and only then deleted from the guest's
 * folder, so a failure leaves it where a turn can still find it until the guest sweep. Size, type
 * and the CSAM scan ran at upload. The account quota is checked here, because without it each round
 * of signing out, uploading as a guest and signing back in adds a guest's quota to the account. A
 * file that does not fit stays under the guest's folder, where the guest sweep deletes it 30 days after
 * upload. Until then the conversation still reads it there, through the `formerGuestSessionId` sign-in
 * stamps on the conversation, as it does a file whose copy failed or a turn sent before this lands. Quarantined files stay where they are, as
 * evidence. Never throws; returns what happened for the caller's log. (CUR-2183)
 */
export async function moveGuestFilesToUser(
	sessionId: string,
	userId: string
): Promise<{ moved: number; failed: number; overQuota: number } | undefined> {
	if (!custodialStorageConfigured()) return undefined;
	let guest: string;
	let entries: ListFileEntry[];
	let fileCount: number;
	let usedBytes: number;
	try {
		guest = ownerPrefix("guests", sessionId);
		// Pastes move too, or a signed-in turn would look for one under users/ and not find it.
		entries = await listOwnerFiles({ root: "guests", id: sessionId }, { includePastes: true });
		if (entries.length === 0) return { moved: 0, failed: 0, overQuota: 0 };
		const account = await listOwnerFiles({ root: "users", id: userId });
		fileCount = account.length;
		usedBytes = account.reduce((sum, e) => sum + (e.size ?? 0), 0) + (inFlightBytes.get(userId) ?? 0);
	} catch {
		return { moved: 0, failed: 1, overQuota: 0 };
	}
	let moved = 0;
	let failed = 0;
	let overQuota = 0;
	forgetQuotaListing({ root: "users", id: userId });
	forgetQuotaListing({ root: "guests", id: sessionId });
	for (const entry of entries) {
		const paste = isPastePath(entry.path.slice(guest.length));
		const size = paste ? 0 : (entry.size ?? 0);
		if (
			!paste &&
			(fileCount + 1 > CUSTODIAL_MAX_FILES_PER_USER || usedBytes + size > CUSTODIAL_MAX_TOTAL_BYTES_PER_USER)
		) {
			overQuota++;
			continue;
		}
		try {
			const target = resolveUserPath(userId, entry.path.slice(guest.length));
			assertOwnership(userId, target);
			// Opened under the guest and sealed again to the account, or the account could never open it.
			const content = await readOpened(ownerGrant("guests", sessionId), entry.path);
			if (!content) continue;
			const sealed = await sealedForWrite({ root: "users", id: userId }, content);
			await uploadFile({ repo: custodialBucketRepo(), file: { path: target, content: sealed }, ...hubAuth() });
			if (!paste) fileCount++;
			usedBytes += size;
			await deleteFile({ repo: custodialBucketRepo(), path: entry.path, ...hubAuth() });
			moved++;
		} catch {
			failed++;
		}
	}
	if (overQuota > 0) {
		// Awaited: this runs inside the caller's runInBackground, which keeps only this promise alive.
		await recordRateLimitTrip(`custodial-storage:quota:${userId}`, {
			limitName: "custodial storage quota",
			identity: `${userId} (${fileCount} files, ${usedBytes} bytes; ${overQuota} guest file(s) left behind at sign-in)`,
		});
	}
	return { moved, failed, overQuota };
}

/**
 * A guest's attachments are deleted `retentionMs` after upload, each on its own clock, by
 * the bucket's own `uploadedAt`. Not by the conversation's `updatedAt`: one message a month would
 * keep a conversation alive forever and every file in it with it. Quarantined files are kept, as
 * CSAM-match evidence. A file with no `uploadedAt` is left alone and counted, since its age is
 * unknown. Every deleted path is checked against guests/<id>/ here, whatever the listing returned.
 * @returns undefined when this deployment has no bucket. (CUR-2183)
 */
export async function sweepExpiredGuestFiles(
	retentionMs: number,
	now: Date = new Date()
): Promise<{ deleted: number; failed: number; undated: number } | undefined> {
	if (!custodialStorageConfigured()) return undefined;
	const cutoff = now.getTime() - retentionMs;
	const result = { deleted: 0, failed: 0, undated: 0 };
	for await (const entry of listFiles({
		repo: custodialBucketRepo(),
		path: "guests/",
		recursive: true,
		...hubAuth(),
	})) {
		// Only a path already in canonical form: `guests/<a>/../users/...` normalises to a guests/ path
		// that passes the ownership check, while the delete would be sent with the raw one.
		if (entry.type !== "file" || path.posix.normalize(entry.path) !== entry.path) continue;
		const owner = /^guests\/([^/]+)\//.exec(entry.path)?.[1];
		if (!owner) continue;
		try {
			assertOwnerOwnership("guests", owner, entry.path);
		} catch {
			continue;
		}
		if (entry.path.startsWith(`${ownerPrefix("guests", owner)}${CUSTODIAL_QUARANTINE_DIRNAME}/`)) continue;
		const uploaded = entry.uploadedAt ? Date.parse(entry.uploadedAt) : NaN;
		if (Number.isNaN(uploaded)) {
			result.undated++;
			continue;
		}
		if (uploaded >= cutoff) continue;
		try {
			await deleteFile({ repo: custodialBucketRepo(), path: entry.path, ...hubAuth() });
			result.deleted++;
		} catch {
			result.failed++;
		}
	}
	return result;
}

/** `readCustodialAttachment` for a guest's attachment under `guests/<sessionId>/` (CUR-2183). */
export async function readGuestAttachment(sessionId: string, relativePath: string, keys?: KeyStore): Promise<Blob | null> {
	const bucketPath = resolveOwnerPath("guests", sessionId, relativePath);
	assertOwnerOwnership("guests", sessionId, bucketPath);
	if (bucketPath.startsWith(`${ownerPrefix("guests", sessionId)}${CUSTODIAL_QUARANTINE_DIRNAME}/`)) {
		throw new OwnershipMismatchError(sessionId, bucketPath);
	}
	return readOpened(ownerGrant("guests", sessionId), bucketPath, keys);
}

/**
 * Every file under the given folders of the person's own prefix, deleted (CUR-2183). Used when
 * conversations are deleted, for their attachment folders (`conversations/<id>`).
 *
 * One listing of the folders' common parent, however many folders are named, so Delete-all over a
 * hundred conversations costs one listing and not a hundred (~320 ms each on the preview bucket; a
 * folder that does not exist lists as empty rather than throwing).
 * @returns the number of files deleted, or `undefined` when no bucket is configured.
 * @throws CustodialWipeError when the listing or any delete fails, so the caller does not report the
 * conversations as deleted while their files remain.
 */
export async function deleteCustodialFolders(
	userId: string,
	parentDir: string,
	childNames: string[],
	// "guests" for a guest's session, whose id goes in `userId`. (CUR-2183)
	root: StorageRoot = "users"
): Promise<number | undefined> {
	if (!custodialStorageConfigured()) return undefined;
	if (childNames.length === 0) return 0;
	const parent = `${resolveOwnerPath(root, userId, parentDir)}/`;
	assertOwnerOwnership(root, userId, parent);
	const targets = childNames.map((name) => `${resolveOwnerPath(root, userId, `${parentDir}/${name}`)}/`);
	const paths: string[] = [];
	try {
		for await (const entry of listFiles({
			repo: custodialBucketRepo(),
			path: parent,
			recursive: true,
			...hubAuth(),
		})) {
			if (entry.type !== "file") continue;
			assertOwnerOwnership(root, userId, entry.path);
			if (targets.some((t) => entry.path.startsWith(t))) paths.push(entry.path);
		}
	} catch (e) {
		throw new CustodialWipeError(0, 0, e);
	}
	forgetQuotaListing({ root, id: userId });
	return deleteAllOrThrow(paths);
}

/**
 * The Hub URL of a call Hugging Face refused because the shared storage token hit its rate limit
 * (3,000 Hub calls per 5 minutes on the team plan), or null for any other error (CUR-3120).
 */
export function hubRateLimitedUrl(e: unknown): string | null {
	return e instanceof HubApiError && e.statusCode === 429 ? e.url : null;
}

/** A read worth one more try: the Hub throttled it (429), failed on its side (5xx), or it never landed
 *  (CUR-3291). Kept here so the Hub SDK stays inside this declared store (wipeCoverage.spec.ts). */
export function transientHubError(e: unknown): boolean {
	return e instanceof HubApiError ? e.statusCode === 429 || e.statusCode >= 500 : e instanceof TypeError;
}

/** The error the Hub SDK throws when it is rate-limited, for the `storage_hub_rate_limited` fault. */
export function hubRateLimitedError(url: string): Error {
	return new HubApiError(url, 429);
}
