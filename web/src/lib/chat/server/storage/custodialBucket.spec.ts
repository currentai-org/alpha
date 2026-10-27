// "real tests trying to escape another user's prefix, not just the happy path." The
// happy-path tests exist to pin the layout; the escape tests are the actual point of this file.
//
// The path-traversal test below (CUR-928) goes red for the failure it names: reverting
// assertOwnership's normalize-first call fails it and only it. The exposure is real, since
// /chat/storage (CUR-1276) is a live route on a single shared credential. (CUR-412)
import { describe, it, expect } from "vitest";
import {
	userPrefix,
	resolveUserPath,
	custodialFilePath,
	assertOwnership,
	InvalidUserIdError,
	PathEscapesUserPrefixError,
	OwnershipMismatchError,
} from "./custodialBucket";

const ME = "abc123UserId";
const OTHER = "zzz999OtherUser";

describe("userPrefix", () => {
	it("builds users/<id>/ for a valid id", () => {
		expect(userPrefix(ME)).toBe(`users/${ME}/`);
	});

	it.each([
		["", "empty string"],
		["../escape", "contains .."],
		["a/b", "contains a slash"],
		["a\\b", "contains a backslash"],
		["a.b", "contains a dot"],
		["a".repeat(129), "too long"],
	])("rejects an id that is %s (%s)", (badId) => {
		expect(() => userPrefix(badId)).toThrow(InvalidUserIdError);
	});
});

describe("resolveUserPath — happy path", () => {
	it("resolves a plain relative path under the user's own folder", () => {
		expect(resolveUserPath(ME, "conversations/abc.json")).toBe(
			`users/${ME}/conversations/abc.json`
		);
	});

	it("resolves the empty path to the user's own folder root, without a trailing slash", () => {
		expect(resolveUserPath(ME, "")).toBe(`users/${ME}`);
	});

	it("normalizes a harmless internal '..' that never leaves the user's folder", () => {
		expect(resolveUserPath(ME, "documents/sub/../report.pdf")).toBe(
			`users/${ME}/documents/report.pdf`
		);
	});
});

describe("resolveUserPath — escape attempts (the actual point of this file)", () => {
	it("rejects a '..' chain that walks into a DIFFERENT, otherwise-valid user's folder", () => {
		expect(() => resolveUserPath(ME, `../${OTHER}/secret.txt`)).toThrow(
			PathEscapesUserPrefixError
		);
	});

	it("rejects a '..' chain deep enough to reach outside users/ entirely", () => {
		expect(() => resolveUserPath(ME, "../../../etc/passwd")).toThrow(PathEscapesUserPrefixError);
	});

	it("rejects an absolute path, which would otherwise override the prefix outright", () => {
		expect(() => resolveUserPath(ME, "/etc/passwd")).toThrow(PathEscapesUserPrefixError);
	});

	it("a NUL byte in the filename is inert here — no segment boundary for POSIX path resolution", () => {
		// Documented, not a claim that a NUL byte is safe everywhere — a real backend writing this key
		// to a filesystem or another API is its own attack surface this module doesn't cover.
		expect(resolveUserPath(ME, "conversations/abc.json\0.txt")).toBe(
			`users/${ME}/conversations/abc.json\0.txt`
		);
	});

	it("treats a URL-encoded '../' as an inert literal filename segment — decode BEFORE calling this", () => {
		// This is the contract, made concrete: resolveUserPath operates on an already-decoded string.
		// A caller that forwards a raw, still-percent-encoded path segment gets false safety here — the
		// encoded form never escapes because path.posix.resolve doesn't decode it, but the DECODED
		// equivalent (next assertion) does escape, proving the encoded string was never actually safe,
		// just not yet interpreted as a traversal.
		expect(() => resolveUserPath(ME, "..%2f..%2fetc%2fpasswd")).not.toThrow();
		expect(() => resolveUserPath(ME, decodeURIComponent("..%2f..%2fetc%2fpasswd"))).toThrow(
			PathEscapesUserPrefixError
		);
	});

	it("treats a backslash as an ordinary filename character, not a path separator", () => {
		// Bucket keys are POSIX-style strings, not real OS paths — a Windows-style traversal attempt
		// stays inert here regardless of the host OS this code happens to run on.
		expect(resolveUserPath(ME, "..\\..\\etc\\passwd")).toBe(
			`users/${ME}/..\\..\\etc\\passwd`
		);
	});

	it("a raw string PREFIX match is not enough — 'users/<id>extra/...' must not pass as <id>'s own path", () => {
		// This is CUR-412's own "checking the path template is not enough" made concrete: a naive
		// `path.startsWith('users/' + userId)` check (no trailing slash) would wrongly accept this.
		const decoyPath = `users/${ME}extra-suffix/secret.txt`;
		expect(decoyPath.startsWith(`users/${ME}`)).toBe(true); // the naive check would wrongly pass
		expect(() => assertOwnership(ME, decoyPath)).toThrow(OwnershipMismatchError);
	});
});

describe("custodialFilePath", () => {
	it.each(["conversations", "documents"] as const)("builds a path under the %s subfolder", (sub) => {
		expect(custodialFilePath(ME, sub, "file.txt")).toBe(`users/${ME}/${sub}/file.txt`);
	});
});

describe("assertOwnership — the per-request check, independent of path structure", () => {
	it("passes when the path's own users/<id>/ segment matches the session", () => {
		expect(() => assertOwnership(ME, resolveUserPath(ME, "documents/report.pdf"))).not.toThrow();
	});

	it("rejects a path legitimately built for a DIFFERENT user, even though nothing about its own construction was unsafe", () => {
		const othersPath = resolveUserPath(OTHER, "documents/report.pdf");
		expect(() => assertOwnership(ME, othersPath)).toThrow(OwnershipMismatchError);
	});

	it("rejects a path with no users/ segment at all", () => {
		expect(() => assertOwnership(ME, "not-even-a-users-path/file.txt")).toThrow(
			OwnershipMismatchError
		);
	});

	it("rejects a malformed session user id before it can compare anything", () => {
		expect(() => assertOwnership("../escape", "users/ME/file.txt")).toThrow(InvalidUserIdError);
	});

	it("rejects an unnormalized '..' traversal that resolves into a DIFFERENT user's folder, even though the raw string's first segment is the caller's own id (CUR-928)", () => {
		// path.posix.resolve/normalize collapses this to `users/${OTHER}/documents/tax.pdf` — what a
		// normalizing backend actually serves — but a regex match against the RAW string captures
		// `${ME}` as the owning segment, since `[^/]+` stops at the first `/` regardless of what
		// follows. A caller that hands assertOwnership an unnormalized path (anything not built
		// through resolveUserPath above) must still be caught here, per this function's own contract.
		const rawTraversalPath = `users/${ME}/../${OTHER}/documents/tax.pdf`;
		expect(() => assertOwnership(ME, rawTraversalPath)).toThrow(OwnershipMismatchError);
	});
});
