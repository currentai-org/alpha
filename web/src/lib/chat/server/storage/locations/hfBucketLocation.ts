// A Hugging Face bucket the person owns, linked with a token they gave us. Every path is
// confined to the location's `prefix` by `resolveUnderPrefix`/`assertUnderPrefix`, the same shape of
// check custodialBucket.ts makes for users/<id>/. Here the person's own token is the outer wall (it
// reaches only what they granted), so the prefix check guards the folder they chose, not other people. (CUR-2930)
import path from "node:path";
import {
	deleteFile,
	downloadFile,
	HubApiError,
	listFiles,
	pathsInfo,
	uploadFile,
	whoAmI,
} from "@huggingface/hub";
import { CUSTODIAL_MAX_BYTES_PER_FILE } from "$lib/chat/constants/custodialUpload";
import { screenUploadForUser, type UploadOptions } from "../custodialStorage";
import { LocationUnavailableError, type LocationFolder, type StorageLocation } from "./types";

/** `buckets/<namespace>/<name>`, the designation @huggingface/hub takes. Same shape custodialStorage
 *  holds HF_BUCKETS_REPO to. */
const BUCKET_REPO_SHAPE = /^buckets\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
const SEGMENT = /^[\w.-]+$/;

/** Thrown for a path outside the location's folder, or one that is not in normal form. */
export class PathOutsideLocationError extends Error {
	name = "PathOutsideLocationError";
}

/** A bucket name as a person types it (`me/files`, `buckets/me/files`, or the hf.co URL), or null. */
export function parseBucketRepo(input: string): string | null {
	const trimmed = input
		.trim()
		.replace(/^https?:\/\/(www\.)?(huggingface\.co|hf\.co)\//, "")
		.replace(/\/+$/, "");
	const repo = trimmed.startsWith("buckets/") ? trimmed : `buckets/${trimmed}`;
	return BUCKET_REPO_SHAPE.test(repo) ? repo : null;
}

/** "" for the whole bucket, else `a/b/`. null when a segment is empty, `.`/`..`, or has odd characters. */
export function normalizePrefix(input: string): string | null {
	const parts = input.split("/").filter((p) => p !== "");
	if (parts.some((p) => p === "." || p === ".." || !SEGMENT.test(p))) return null;
	return parts.length ? `${parts.join("/")}/` : "";
}

/** A path a listing returned, re-checked: normal form, no traversal, under the prefix. */
export function assertUnderPrefix(prefix: string, p: string): string {
	if (p.includes("\0") || p.startsWith("/") || path.posix.normalize(p) !== p || p.split("/").includes("..")) {
		throw new PathOutsideLocationError(`not a path in this location: ${JSON.stringify(p)}`);
	}
	if (!p.startsWith(prefix) || p === prefix) {
		throw new PathOutsideLocationError(`not a path in this location: ${JSON.stringify(p)}`);
	}
	return p;
}

/** `<prefix><folder>/<name>`, checked. `name` must already be a single segment (the route's basename). */
export function resolveUnderPrefix(prefix: string, folder: string, name: string): string {
	if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
		throw new PathOutsideLocationError(`not a file name: ${JSON.stringify(name)}`);
	}
	return assertUnderPrefix(prefix, `${prefix}${folder}/${name}`);
}

/** 401, 403 and 404 from the Hub all mean the same thing to the person: this location stopped answering
 *  for its token. Anything else is a failure and propagates as itself. */
function unavailable(locationId: string, e: unknown): never {
	if (e instanceof HubApiError && [401, 403, 404].includes(e.statusCode)) {
		throw new LocationUnavailableError(
			locationId,
			e.statusCode === 404
				? "That bucket isn't there any more, or the token can no longer see it."
				: "Hugging Face refused the token for this bucket. It may have expired or been revoked.",
			{ cause: e }
		);
	}
	throw e;
}

export type HfBucketParams = {
	id: string;
	label: string;
	userId: string;
	repo: string;
	prefix: string;
	token: string;
};

export function hfBucketLocation(p: HfBucketParams): StorageLocation {
	const cred = { repo: p.repo, accessToken: p.token };
	return {
		id: p.id,
		kind: "hf-bucket",
		label: p.label,
		capabilities: () => ({
			serverSideCopyWithin: true,
			// Bytes pass through one of our functions, which Vercel caps near 4.5 MB each way.
			maxTransferBytes: CUSTODIAL_MAX_BYTES_PER_FILE,
			grant: "bucket",
		}),
		async list() {
			const files = [];
			try {
				for await (const e of listFiles({ ...cred, path: p.prefix || undefined, recursive: true })) {
					if (e.type !== "file") continue;
					// Same defense in depth as custodialStorage: re-derive from each entry, never trust the filter.
					files.push({ path: assertUnderPrefix(p.prefix, e.path), size: e.size });
				}
			} catch (e) {
				unavailable(p.id, e);
			}
			return files;
		},
		async stat(filePath) {
			assertUnderPrefix(p.prefix, filePath);
			try {
				const [info] = await pathsInfo({ ...cred, paths: [filePath] });
				return info && info.type === "file" ? { size: info.size, hash: info.xetHash ?? info.oid } : null;
			} catch (e) {
				if (e instanceof HubApiError && e.statusCode === 404) return null;
				unavailable(p.id, e);
			}
		},
		async read(filePath) {
			assertUnderPrefix(p.prefix, filePath);
			try {
				return await downloadFile({ ...cred, path: filePath });
			} catch (e) {
				// A missing file is a missing file: `null` per the interface, never "the bucket is gone".
				if (e instanceof HubApiError && e.statusCode === 404) return null;
				unavailable(p.id, e);
			}
		},
		async write(folder: LocationFolder, name: string, content: Blob, opts: UploadOptions) {
			const target = resolveUnderPrefix(p.prefix, folder, name);
			// Before the write, never after: a refused file must not reach the person's bucket either.
			await screenUploadForUser(p.userId, name, content, opts);
			try {
				await uploadFile({ ...cred, file: { path: target, content } });
			} catch (e) {
				unavailable(p.id, e);
			}
			return target;
		},
		async delete(filePath) {
			assertUnderPrefix(p.prefix, filePath);
			try {
				await deleteFile({ ...cred, path: filePath });
			} catch (e) {
				// Already gone is what a delete wants.
				if (e instanceof HubApiError && e.statusCode === 404) return;
				unavailable(p.id, e);
			}
		},
	};
}

/** Why a link attempt was refused, in words for the person typing the token. */
export class LinkRefusedError extends Error {
	name = "LinkRefusedError";
}

/**
 * Check a token before we keep it: Hugging Face accepts it, it is not read-only, and it can list the
 * bucket. Write access itself is only proven by the first write (fine-grained tokens do not report
 * their per-bucket permissions), and a refused write marks the location for reconnecting.
 * @returns the token owner's Hub username.
 */
export async function verifyBucketLink(repo: string, prefix: string, token: string): Promise<string> {
	let who: Awaited<ReturnType<typeof whoAmI>>;
	try {
		who = await whoAmI({ accessToken: token });
	} catch (e) {
		if (e instanceof HubApiError && e.statusCode === 401) {
			throw new LinkRefusedError("Hugging Face didn't accept that token. Check you copied all of it.");
		}
		throw e;
	}
	if (who.auth.accessToken?.role === "read") {
		throw new LinkRefusedError("That token is read-only. Alpha needs write access to put files in the bucket.");
	}
	try {
		const it = listFiles({ repo, accessToken: token, path: prefix || undefined })[Symbol.asyncIterator]();
		await it.next();
	} catch (e) {
		if (e instanceof HubApiError && [401, 403, 404].includes(e.statusCode)) {
			throw new LinkRefusedError(
				"That token can't see this bucket. Check the bucket name, and that the token has access to it."
			);
		}
		throw e;
	}
	return who.name;
}
