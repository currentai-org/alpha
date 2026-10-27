// The custodial-storage layout (CUR-412): a top-level users/ folder, one folder per person, with
// subfolders inside for conversations, documents and whatever else we keep. A users/<id>/ layout is
// organisation, not access control. One shared enterprise credential holds everyone's files, so every
// read/write needs its own server-side check that the requesting session owns that id, independent of
// the path structure.
//
// Prior art: LibreChat doesn't trust its own per-user path convention either — it
// validates that every RESOLVED path stays under the expected user-scoped prefix, rather than
// assuming a `{user_id}/filename` string is safe by construction. resolveUserPath below is that
// check: it normalizes `.`/`..`/repeated slashes FIRST, then verifies the resolved result — not the
// input string — still lives under the caller's own prefix.
//
// This app's user ids are NOT RFC-4122 UUIDs. In the installed Better Auth source
// (@better-auth/core/dist/utils/id.mjs), generateId() is a 32-char
// alphanumeric string (a-z, A-Z, 0-9), not the 8-4-4-4-12 hex-and-dash shape. isSafeUserId below
// validates against THAT real shape, not a UUID regex — re-check this if Better Auth's default ever
// changes (a custom `advanced.database.generateId` would also need a matching update here).
//
// Deliberately NOT in this module: a storage backend (custodialStorage.ts does the I/O). What's here
// is provider-agnostic: pure path logic, no I/O, so it doesn't need a real credential to build
// against or to test, and a backend wires in behind these same two checks without touching this
// file.

import path from "node:path";

export class InvalidUserIdError extends Error {
	constructor(userId: string) {
		super(`not a valid custodial-storage user id: ${JSON.stringify(userId)}`);
		this.name = "InvalidUserIdError";
	}
}

export class PathEscapesUserPrefixError extends Error {
	constructor(userId: string, relativePath: string, resolved: string) {
		super(
			`"${relativePath}" for user ${userId} resolves outside their own folder: got "${resolved}"`
		);
		this.name = "PathEscapesUserPrefixError";
	}
}

export class OwnershipMismatchError extends Error {
	constructor(sessionUserId: string, bucketPath: string) {
		super(`session user ${sessionUserId} does not own bucket path "${bucketPath}"`);
		this.name = "OwnershipMismatchError";
	}
}

// Alphanumeric + `_`/`-`, 1-128 chars: matches Better Auth's real id shape with room for a longer or
// differently-charactered id later, while still excluding every path-special character (`/`, `\`,
// `.`, null bytes) a traversal or backend-path-injection attempt would need.
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeUserId(userId: string): void {
	if (!SAFE_USER_ID.test(userId)) throw new InvalidUserIdError(userId);
}

/**
 * The two top-level folders an owner's files can live under (CUR-2183): `users/<id>/` for a
 * signed-in person, `guests/<sessionId>/` for a visitor's chat attachments. A guest's session id is
 * the sha256 hex of their anonymous cookie, which already fits SAFE_USER_ID.
 */
export type StorageRoot = "users" | "guests";

/** The folder one owner's files live under. Always ends in "/". */
export function ownerPrefix(root: StorageRoot, id: string): string {
	assertSafeUserId(id);
	return `${root}/${id}/`;
}

/** The folder a person's files live under. Always ends in "/". */
export function userPrefix(userId: string): string {
	return ownerPrefix("users", userId);
}

export const CUSTODIAL_SUBFOLDERS = ["conversations", "documents"] as const;
export type CustodialSubfolder = (typeof CUSTODIAL_SUBFOLDERS)[number];

// A CSAM-matched upload is quarantined here instead of its normal subfolder — excluded from
// listCustodialFiles's walk the same way agent-service's ARTIFACT_QUARANTINE_DIRNAME (CUR-836) is
// excluded from that codebase's own artifact listing. Not one of CUSTODIAL_SUBFOLDERS: nothing should
// ever resolve a user-facing upload path into this folder by name collision. (CUR-1136)
export const CUSTODIAL_QUARANTINE_DIRNAME = "quarantine";

/**
 * Resolves `relativePath` against `userId`'s own folder and returns the bucket key — but only after
 * normalizing `.`/`..`/repeated slashes and confirming the RESOLVED result still lives under that
 * folder. Throws PathEscapesUserPrefixError otherwise, including for an absolute path (which
 * path.posix.resolve treats as overriding everything before it — also caught here) and for a
 * traversal that lands inside a DIFFERENT, otherwise-valid user's folder.
 */
export function resolveUserPath(userId: string, relativePath: string): string {
	return resolveOwnerPath("users", userId, relativePath);
}

/** `resolveUserPath` for either root. */
export function resolveOwnerPath(root: StorageRoot, userId: string, relativePath: string): string {
	const prefix = ownerPrefix(root, userId);
	// Rooted at "/" so ".." can't walk above the bucket root either — path.posix.resolve stops
	// popping at the root rather than erroring, so a deep enough ".." chain still lands somewhere
	// resolvable (never a thrown exception here), and the prefix check below is what catches it.
	const resolved = path.posix.resolve("/", prefix, relativePath).slice(1);
	const prefixWithoutSlash = prefix.slice(0, -1);
	if (resolved !== prefixWithoutSlash && !resolved.startsWith(prefix)) {
		throw new PathEscapesUserPrefixError(userId, relativePath, resolved);
	}
	return resolved;
}

/** `resolveUserPath`, scoped to one of the layout's own named subfolders. */
export function custodialFilePath(
	userId: string,
	subfolder: CustodialSubfolder,
	filename: string
): string {
	return resolveUserPath(userId, `${subfolder}/${filename}`);
}

/**
 * THE per-request check, independent of how `bucketPath` was built. Re-derives ownership from the
 * path's OWN `users/<id>/` segment and compares it to the session's user id — call this at every
 * real read/write boundary (not just when a path was built through resolveUserPath above), since the
 * ticket's own constraint is that the layout is organisation, not access control, and a caller that
 * skipped resolveUserPath is exactly the gap this exists to close.
 */
export function assertOwnership(sessionUserId: string, bucketPath: string): void {
	assertOwnerOwnership("users", sessionUserId, bucketPath);
}

/**
 * True for a path that a URL parser could resolve differently from how `path.posix` reads
 * it. @huggingface/hub puts a bucket path into a request URL unencoded, and WHATWG URL parsing
 * collapses a dot segment written as `.`, `..`, `%2e`, `%2e%2e`, `.%2e` or `%2e.` (any case), and
 * treats `\` as `/`. posix.normalize sees none of the encoded forms and treats `\` as an ordinary
 * character, so each of them could pass a prefix check here and land somewhere else in the bucket.
 * No path the listing returns contains any of them, so they are refused rather than resolved. (CUR-3180)
 */
export function hasAmbiguousSegment(bucketPath: string): boolean {
	// A URL parser strips tab, LF and CR before resolving dot segments, so `.<TAB>.` reaches the
	// bucket as `..`; refuse every control character rather than enumerate the stripped ones.
	return (
		[...bucketPath].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ||
		bucketPath.includes("\\") ||
		bucketPath.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))
	);
}

/** `assertOwnership` for either root: the path's own `<root>/<id>/` segment must name `sessionUserId`. */
export function assertOwnerOwnership(root: StorageRoot, sessionUserId: string, bucketPath: string): void {
	assertSafeUserId(sessionUserId);
	// Every caller gets this, so a path the bucket's URL would resolve differently never
	// reaches the prefix checks below (or assertNotQuarantined after them). (CUR-3180)
	if (hasAmbiguousSegment(bucketPath)) {
		throw new OwnershipMismatchError(sessionUserId, bucketPath);
	}
	// Normalize FIRST (CUR-928): a raw regex match against bucketPath as given captures whatever
	// segment happens to sit right after "users/", even when a `..` later in the same string walks
	// the path into a different user's folder — exactly the gap resolveUserPath's own normalize-then-
	// verify approach above exists to close, but assertOwnership must re-derive it independently since
	// callers aren't guaranteed to have gone through resolveUserPath first.
	const normalized = path.posix.normalize(bucketPath);
	const match = (root === "users" ? /^users\/([^/]+)\// : /^guests\/([^/]+)\//).exec(normalized);
	if (!match || match[1] !== sessionUserId) {
		throw new OwnershipMismatchError(sessionUserId, bucketPath);
	}
}
