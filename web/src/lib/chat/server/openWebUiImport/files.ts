/**
 * Brings each person's Open WebUI uploads into their Alpha files.
 *
 * @remarks
 * Every byte goes through Alpha's own upload path, the one My files uses (`uploadCustodialFile`): the
 * size and type checks, the hourly rate, the safety scan, then the sealed write. Nothing here writes a
 * table or a bucket directly, so an imported file is held to exactly what a file the person uploads
 * today is, and one the scan refuses is skipped with the scan's own reason.
 *
 * Each file lands at `documents/owui-<id>-<name>`. That path carries the Open WebUI file id, so it is
 * also the idempotence key: a rerun finds it stored and uploads nothing. A file that is not itself text
 * gets a text sidecar beside it, `<path>.txt`, holding the text Open WebUI extracted (`file.data.content`),
 * or, when it kept none, the text Alpha's own extractor reads. The sidecar goes through the same path.
 *
 * Where the bytes are: Open WebUI's `STORAGE_PROVIDER` decides. `local` (the default) keeps them in
 * `DATA_DIR/uploads`, and only the file's last path segment is joined onto that directory, so a stored
 * path can never point the importer outside it. `s3` keeps them at `s3://bucket/key`, read with the
 * install's `S3_*` settings, and Open WebUI also leaves a copy in `uploads`, which is the fallback.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import mimeTypes from "mime-types";
import type { MessageFile } from "$lib/chat/types/Message";
import { sha256 } from "$lib/chat/utils/sha256";
import { userPrefix } from "$lib/chat/server/storage/custodialBucket";
import { ALPHA_LOCATION_ID } from "$lib/chat/server/storage/locations/types";
import type { SourceFile } from "./sourceRows";
import type { UserReport } from "./report";

const IMPORTED_FILE_FOLDER = "documents";
const MAX_NAME = 255;

type ReadResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

export interface FileDeps {
	/** The file's bytes, or why they cannot be read. */
	readBytes(file: SourceFile): Promise<ReadResult>;
	/** Paths relative to the person's own folder that are already stored. */
	listStored(accountId: string): Promise<Set<string>>;
	/** Alpha's upload path: size, type, rate and the safety scan, then the write. Throws to refuse. */
	upload(accountId: string, relativePath: string, content: Blob): Promise<void>;
	/** The full path Alpha's storage location reads `relativePath` back at (it carries the owner's prefix). */
	storedPath(accountId: string, relativePath: string): string;
	/** Text Alpha's own extractor reads from the bytes, or null. Used only when Open WebUI kept none. */
	extractText(bytes: Uint8Array, name: string): Promise<string | null>;
}

/** The last path segment of `name`, with control characters removed; never empty, `.` or `..`. */
function safeName(name: string): string {
	// eslint-disable-next-line no-control-regex
	const last = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return !last || last === "." || last === ".." ? "file" : last;
}

/** Where an Open WebUI file is stored for its owner, relative to their folder. Stable across runs. */
export function importedPath(file: Pick<SourceFile, "id" | "filename">): string {
	const id = file.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "file";
	const prefix = `owui-${id}-`;
	let name = safeName(file.filename);
	// Room for the sidecar's `.txt`, so both names fit the 255 every filesystem accepts.
	const room = MAX_NAME - prefix.length - 4;
	if (name.length > room) {
		const dot = name.lastIndexOf(".");
		const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
		name = name.slice(0, room - ext.length) + ext;
	}
	return `${IMPORTED_FILE_FOLDER}/${prefix}${name}`;
}

export const sidecarPath = (path: string): string => `${path}.txt`;

/** A file that is text already needs no text copy beside it. */
function isText(file: SourceFile): boolean {
	return (file.contentType ?? "").startsWith("text/") || /\.(txt|md|markdown|csv|tsv)$/i.test(file.filename);
}

/**
 * What the import made of one Open WebUI file, for the messages that carried it: the
 * reference a normal chat attachment holds, or why there is none.
 */
export type ImportedFile = { ok: true; ref: MessageFile } | { ok: false; reason: string };

/**
 * The reference a chat attachment kept in Alpha storage holds (`storeChatAttachments`): the sha over the
 * file's text decoding, the name and mime, and the location the bytes are read back from. The imported
 * file sits in the person's `documents/` folder rather than under a conversation, so the reference names
 * its full path in the Alpha location, the way an attachment sent to a linked location does.
 */
async function messageRef(file: SourceFile, fullPath: string, bytes: Uint8Array): Promise<MessageFile> {
	const name = fullPath.split("/").pop()!;
	const sha = await sha256(await new Blob([bytes as BlobPart]).text());
	const mime = file.contentType || (mimeTypes.lookup(file.filename) as string | false) || "application/octet-stream";
	return { type: "hash", value: sha, mime, name, location: { id: ALPHA_LOCATION_ID, path: fullPath } };
}

const isRateLimit = (e: unknown) => e instanceof Error && e.name === "UploadRateLimitedError";

/** Who owns an Open WebUI user's files in Alpha: an account id, "dry" in a dry run, or null when they could not be imported. */
export type FileOwner = string | "dry" | null;

/**
 * Uploads each file to its owner through `deps.upload` and counts the outcome on the owner's report.
 * `owners` maps an Open WebUI user id to the Alpha account the import resolved for them.
 */
export async function importFiles(
	files: readonly SourceFile[],
	owners: ReadonlyMap<string, FileOwner>,
	reportFor: (sourceUserId: string) => UserReport,
	deps: FileDeps
): Promise<Map<string, ImportedFile>> {
	const results = new Map<string, ImportedFile>();
	const stored = new Map<string, Set<string>>();
	const rateLimited = new Set<string>();
	const storedFor = async (accountId: string) => {
		let set = stored.get(accountId);
		if (!set) {
			set = await deps.listStored(accountId);
			stored.set(accountId, set);
		}
		return set;
	};

	for (const file of files) {
		const report = reportFor(file.userId);
		report.files.in += 1;
		const owner = owners.get(file.userId);
		const skip = (reason: string) => {
			report.files.skipped.push({ id: file.id, reason });
			results.set(file.id, { ok: false, reason });
		};
		if (owner === undefined) {
			skip("the file's user_id matches no user row");
			continue;
		}
		if (owner === null) {
			skip(report.accountNote ?? "the owner was not created");
			continue;
		}
		const path = importedPath(file);
		if (owner === "dry") {
			report.files.imported += 1;
			continue;
		}
		if (rateLimited.has(owner)) {
			skip("the hourly upload limit was reached; a rerun picks this file up");
			continue;
		}
		const have = await storedFor(owner);
		const wantsSidecar = !isText(file);
		const mainStored = have.has(path);
		if (mainStored && (!wantsSidecar || have.has(sidecarPath(path)))) {
			// Stored on an earlier run. The bytes are read again for the sha a message's reference carries.
			const again = await deps.readBytes(file);
			if (again.ok) {
				report.files.unchanged += 1;
				results.set(file.id, { ok: true, ref: await messageRef(file, deps.storedPath(owner, path), again.bytes) });
			} else {
				// Present in Alpha, but without its bytes there is no sha to reference it by.
				report.files.unchanged += 1;
				results.set(file.id, { ok: false, reason: `already stored, but messages cannot reference it: ${again.reason}` });
			}
			continue;
		}

		const read = await deps.readBytes(file);
		if (!read.ok) {
			skip(read.reason);
			continue;
		}
		if (!mainStored) {
			try {
				await deps.upload(owner, path, new Blob([read.bytes as BlobPart], { type: file.contentType ?? "" }));
			} catch (e) {
				if (isRateLimit(e)) rateLimited.add(owner);
				skip(isRateLimit(e) ? "the hourly upload limit was reached; a rerun picks this file up" : `refused by the upload path: ${(e as Error).message}`);
				continue;
			}
			have.add(path);
			report.files.imported += 1;
		} else {
			// Stored on an earlier run whose sidecar did not make it; only the sidecar is retried.
			report.files.unchanged += 1;
		}
		results.set(file.id, { ok: true, ref: await messageRef(file, deps.storedPath(owner, path), read.bytes) });
		if (!wantsSidecar) continue;

		const text = file.text ?? (await deps.extractText(read.bytes, file.filename).catch(() => null));
		if (!text) {
			report.files.sidecarNotes.push({ id: file.id, reason: "no text in the source and none Alpha could read" });
			continue;
		}
		try {
			await deps.upload(owner, sidecarPath(path), new Blob([text], { type: "text/plain" }));
			have.add(sidecarPath(path));
			report.files.sidecars += 1;
		} catch (e) {
			if (isRateLimit(e)) rateLimited.add(owner);
			report.files.sidecarNotes.push({
				id: file.id,
				reason: isRateLimit(e) ? "the hourly upload limit was reached; a rerun writes the sidecar" : `sidecar refused by the upload path: ${(e as Error).message}`,
			});
		}
	}
	return results;
}

/** Open WebUI's S3 settings (its S3_* env), as the CLI reads them from the operator's environment. */
export interface S3Settings {
	accessKeyId?: string;
	secretAccessKey?: string;
	region?: string;
	endpoint?: string;
	addressingStyle?: string;
}

type S3Get = (bucket: string, key: string) => Promise<Uint8Array>;

function s3Getter(s: S3Settings): S3Get {
	let client: S3Client | null = null;
	return async (bucket, key) => {
		const sdk = await import("@aws-sdk/client-s3");
		client ??= new sdk.S3Client({
			region: s.region ?? "us-east-1",
			endpoint: s.endpoint,
			forcePathStyle: s.addressingStyle === "path",
			credentials: s.accessKeyId && s.secretAccessKey ? { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } : undefined,
		});
		const res = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
		if (!res.Body) throw new Error("empty response body");
		return res.Body.transformToByteArray();
	};
}

/**
 * Reads a file's bytes where Open WebUI keeps them. `dataDir` is the install's `DATA_DIR`;
 * `storageProvider` its `STORAGE_PROVIDER`. `s3Get` replaces the S3 client in a test.
 */
export function fileLocator(opts: { dataDir: string | null; storageProvider: string; s3?: S3Settings; s3Get?: S3Get }): FileDeps["readBytes"] {
	const provider = (opts.storageProvider || "local").toLowerCase();
	const get = opts.s3Get ?? (provider === "s3" ? s3Getter(opts.s3 ?? {}) : null);
	const fromUploads = async (segment: string): Promise<ReadResult> => {
		if (!opts.dataDir) return { ok: false, reason: "no Open WebUI data directory was given (--data-dir)" };
		try {
			return { ok: true, bytes: new Uint8Array(await readFile(join(opts.dataDir, "uploads", safeName(segment)))) };
		} catch (e) {
			return { ok: false, reason: `not found in ${join(opts.dataDir, "uploads")}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
		}
	};
	return async (file) => {
		if (!file.path) return { ok: false, reason: "Open WebUI recorded no storage path for the file" };
		const s3 = /^s3:\/\/([^/]+)\/(.+)$/.exec(file.path);
		if (s3) {
			if (get) {
				try {
					return { ok: true, bytes: await get(s3[1], s3[2]) };
				} catch (e) {
					const local = await fromUploads(s3[2]);
					return local.ok ? local : { ok: false, reason: `S3 read failed (${(e as Error).message}) and ${local.reason}` };
				}
			}
			const local = await fromUploads(s3[2]);
			return local.ok ? local : { ok: false, reason: `stored in S3; set STORAGE_PROVIDER=s3 and the S3_* settings to read it (${local.reason})` };
		}
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file.path)) {
			// gs:// and Azure URLs: Open WebUI keeps a local copy too, which is all this importer reads.
			const local = await fromUploads(file.path);
			return local.ok ? local : { ok: false, reason: `stored by a provider this importer does not read (${file.path.split(":")[0]}); ${local.reason}` };
		}
		return fromUploads(file.path);
	};
}

/** The real dependencies: Alpha's upload path, its listing, and its text extractor. Loaded on first use. */
export function alphaFileDeps(readBytes: FileDeps["readBytes"]): FileDeps {
	return {
		readBytes,
		async listStored(accountId) {
			const { listCustodialFiles } = await import("$lib/chat/server/storage/custodialStorage");
			const prefix = userPrefix(accountId);
			return new Set((await listCustodialFiles(accountId)).map((f) => (f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path)));
		},
		storedPath(accountId, relativePath) {
			return `${userPrefix(accountId)}${relativePath}`;
		},
		async upload(accountId, relativePath, content) {
			const { uploadCustodialFile } = await import("$lib/chat/server/storage/custodialStorage");
			await uploadCustodialFile(accountId, relativePath, content);
		},
		async extractText(bytes, name) {
			const { resolveUploadKind, extractTextFromUpload } = await import("$lib/chat/server/rag/extractFile");
			const kind = await resolveUploadKind({ bytes: bytes.slice(0, 4100), name });
			if (!kind || kind === "image") return null;
			return (await extractTextFromUpload({ bytes, name, kind })).text || null;
		},
	};
}
