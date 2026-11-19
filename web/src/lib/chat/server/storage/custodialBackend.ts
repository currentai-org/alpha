// Where the custodial store keeps its bytes. Ownership checks, quota, scanning and
// per-owner sealing all happen in custodialStorage.ts before a call reaches this module, so every
// backend receives ciphertext only. Three backends:
//
// - `hf` (kind `hf-bucket`): the Hugging Face bucket in HF_BUCKETS_REPO, through @huggingface/hub.
//   Opt-in: an unset CUSTODIAL_STORAGE_BACKEND is a configuration error, never a fallback to this.
// - `s3`: any S3-compatible bucket (AWS S3, MinIO, Garage, R2, Ceph...), through @aws-sdk/client-s3.
//   Credentials come from the AWS SDK's default chain, the same one custodial KMS uses.
// - `local`: a directory on the server's own disk, through node:fs.
//
// Each is a thin adapter over the official SDK or node:fs, not a storage-driver library:
// flydrive's drivers rewrite and refuse keys outside [A-Za-z0-9-_!/. ] when they list, and a person's
// file name may hold any character, so a listing would drop or rename their files.
//
// CUSTODIAL_STORAGE_BACKEND picks the backend for the whole deployment. It is config, never a
// feature switch: the custodial-storage-view flag still decides who sees the surface.
import path from "node:path";
import { listFiles, uploadFile, downloadFile, deleteFile } from "@huggingface/hub";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { config } from "$lib/chat/server/config";
import { deployEnv } from "$lib/chat/server/deployEnv";
import { logger } from "$lib/chat/server/logger";
import { custodialBucketRepoConfigured, PRODUCTION_CUSTODIAL_BUCKET_REPO, resolvedCustodialBucketRepo } from "./custodialBucketRepo";
import { hubFetch } from "./hubThrottle";

/** One stored object, as every backend lists it. `uploadedAt` is an ISO time where the store keeps one. */
export type StoredFile = { type: "file"; path: string; size: number; uploadedAt?: string };

type CustodialBackendKind = "hf-bucket" | "s3" | "local";
/** The values CUSTODIAL_STORAGE_BACKEND takes, and the kind each selects. `hf-bucket` is the kind's own name, kept as an alias. */
const CUSTODIAL_BACKEND_VALUES: Record<string, CustodialBackendKind> = { hf: "hf-bucket", "hf-bucket": "hf-bucket", s3: "s3", local: "local" };
const CUSTODIAL_BACKEND_CHOICES = "hf, s3, local";

/** The four operations the custodial store needs from wherever its bytes live. */
export interface CustodialBackend {
	readonly kind: CustodialBackendKind;
	/** The object's bytes, or null when there is no object at that path. */
	get(objectPath: string): Promise<Blob | null>;
	/** Writes the object, replacing one already at that path. */
	put(objectPath: string, content: Blob, opts?: { signal?: AbortSignal }): Promise<void>;
	/** Removes the object. */
	delete(objectPath: string): Promise<void>;
	/** Every object whose path starts with `prefix`, at any depth. */
	list(prefix: string): AsyncIterable<StoredFile>;
	/** The one object at exactly this path, or null. */
	stat(objectPath: string): Promise<StoredFile | null>;
}

/** Thrown off production when the default Hugging Face backend has no HF_BUCKETS_REPO. It
 *  refuses storage rather than read and write production's bucket under whatever token it holds. */
class CustodialBucketUnsetError extends Error {
	constructor(env: string | null) {
		super(
			`HF_BUCKETS_REPO is not set on this ${env ?? "undeclared"} deployment; only production may use ` +
				`${PRODUCTION_CUSTODIAL_BUCKET_REPO} by default, so custodial storage is refused`
		);
		this.name = "CustodialBucketUnsetError";
	}
}

/** Thrown before any I/O when the configured backend cannot be used. */
class CustodialBackendUnsetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CustodialBackendUnsetError";
	}
}

/** The configured kind, or an error string naming what is wrong with the setting. Exported for the
 *  backup job (scripts/backup-custodial.ts), which must not hold the app's Hugging Face token. */
export function configuredKind(): CustodialBackendKind | { error: string } {
	const raw = config.CUSTODIAL_STORAGE_BACKEND?.trim();
	// No fallback: a deployment that never chose a store must not quietly need a Hugging Face account.
	if (!raw) return { error: `CUSTODIAL_STORAGE_BACKEND is not set; it must be one of ${CUSTODIAL_BACKEND_CHOICES}` };
	if (Object.hasOwn(CUSTODIAL_BACKEND_VALUES, raw)) return CUSTODIAL_BACKEND_VALUES[raw];
	return { error: `CUSTODIAL_STORAGE_BACKEND is ${JSON.stringify(raw)}; it must be one of ${CUSTODIAL_BACKEND_CHOICES}` };
}

/** Why this deployment's backend cannot be used, or null when it can. Reads config only, no I/O.
 *  `credential: false` leaves out the Hugging Face token, for the gate's narrower question. */
function unusableReason({ credential = true }: { credential?: boolean } = {}): string | null {
	const kind = configuredKind();
	if (typeof kind !== "string") return kind.error;
	if (kind === "hf-bucket") {
		if (!custodialBucketRepoConfigured()) return "HF_BUCKETS_REPO is not set";
		return config.HF_BUCKETS_TOKEN || !credential ? null : "HF_BUCKETS_TOKEN is not set";
	}
	if (kind === "s3") return config.CUSTODIAL_S3_BUCKET?.trim() ? null : "CUSTODIAL_STORAGE_BACKEND is s3 and CUSTODIAL_S3_BUCKET is not set";
	const dir = config.CUSTODIAL_LOCAL_DIR?.trim();
	if (!dir) return "CUSTODIAL_STORAGE_BACKEND is local and CUSTODIAL_LOCAL_DIR is not set";
	return path.isAbsolute(dir) ? null : `CUSTODIAL_LOCAL_DIR must be an absolute path, got ${JSON.stringify(dir)}`;
}

let loggedUnusable: string | null = null;

/** Whether this deployment has somewhere to keep custodial files, with the credential to reach it. False
 *  means there is nothing to list, which is a different fact from an empty listing. A misconfigured
 *  backend logs its reason once. */
export function custodialBackendConfigured(): boolean {
	return checkedReason(unusableReason()) === null;
}

/** Whether this deployment names a store at all, which is what decides whether the storage surface can
 *  show. For hf that is HF_BUCKETS_REPO alone; a missing token there fails the first call instead. */
export function custodialBackendChosen(): boolean {
	return checkedReason(unusableReason({ credential: false })) === null;
}

function checkedReason(reason: string | null): string | null {
	const kind = configuredKind();
	// A missing HF_BUCKETS_REPO off production is the ordinary "no storage here" case, which
	// custodialBucketRepo.ts already logs once. Any other reason is an operator's setting gone wrong.
	if (reason && kind !== "hf-bucket" && loggedUnusable !== reason) {
		loggedUnusable = reason;
		logger.error({ deployEnv: deployEnv() ?? null }, `[custodial-storage] ${reason}, so custodial storage is unavailable`);
	}
	return reason;
}

/**
 * Refuses an object path that is absolute or uncanonical, or that holds a `..` segment or a control
 * character. Every caller in custodialStorage.ts has already checked ownership, so this is the
 * backend's own floor: a filesystem or S3 key built from such a path could land outside the store's
 * root or under another owner's prefix.
 */
function assertSafeKey(objectPath: string): void {
	const bad =
		!objectPath ||
		objectPath.startsWith("/") ||
		objectPath.includes("\\") ||
		[...objectPath].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ||
		path.posix.normalize(objectPath) !== objectPath ||
		objectPath.split("/").includes("..");
	if (bad) throw new Error(`custodial backend refused object path ${JSON.stringify(objectPath)}`);
}

// ── hf-bucket ──────────────────────────────────────────────────────────────────────────────────────

const BUCKET_REPO_SHAPE = /^buckets\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/** The one bucket this deployment talks to. Set per environment so preview and production hold their
 *  files in different buckets under different tokens. A malformed value throws rather than
 *  falling back, since silently writing to the production bucket from a preview is the failure this
 *  setting exists to prevent; unset off production throws by name. */
function custodialBucketRepo(): string {
	const configured = resolvedCustodialBucketRepo();
	if (configured === null) throw new CustodialBucketUnsetError(deployEnv());
	if (!BUCKET_REPO_SHAPE.test(configured)) {
		throw new Error(`HF_BUCKETS_REPO must look like buckets/<owner>/<name>, got ${JSON.stringify(configured)}`);
	}
	return configured;
}

/** What every Hub call passes: the storage token, and the fetch that tracks its rate limit. */
function hubAuth(): { accessToken: string; fetch: typeof fetch } {
	const token = config.HF_BUCKETS_TOKEN;
	if (!token) throw new Error("HF_BUCKETS_TOKEN is not configured — custodial storage cannot authenticate");
	return { accessToken: token, fetch: hubFetch };
}

/** The Hugging Face bucket backend, whatever CUSTODIAL_STORAGE_BACKEND says. Exported for the one-shot
 *  move off Hugging Face (custodialMove.ts), which reads from it while the deployment's configured
 *  backend is the destination. Everything else goes through custodialBackend(). */
export const hfBucketBackend: CustodialBackend = {
	kind: "hf-bucket",
	get: (objectPath) => downloadFile({ repo: custodialBucketRepo(), path: objectPath, ...hubAuth() }),
	async put(objectPath, content, opts) {
		await uploadFile({ repo: custodialBucketRepo(), file: { path: objectPath, content }, ...hubAuth(), abortSignal: opts?.signal });
	},
	async delete(objectPath) {
		await deleteFile({ repo: custodialBucketRepo(), path: objectPath, ...hubAuth() });
	},
	async *list(prefix) {
		// listFiles's `path` is always the full repo-relative path whatever filter scoped the request,
		// which is what lets custodialStorage.ts check ownership against each entry's own path.
		for await (const entry of listFiles({ repo: custodialBucketRepo(), path: prefix, recursive: true, ...hubAuth() })) {
			if (entry.type === "file") yield { type: "file", path: entry.path, size: entry.size, uploadedAt: entry.uploadedAt };
		}
	},
	async stat(objectPath) {
		// Listing one exact path returns that file alone, with the bucket's upload time.
		for await (const entry of listFiles({ repo: custodialBucketRepo(), path: objectPath, ...hubAuth() })) {
			if (entry.type === "file" && entry.path === objectPath) {
				return { type: "file", path: entry.path, size: entry.size, uploadedAt: entry.uploadedAt };
			}
		}
		return null;
	},
};

// ── s3 ─────────────────────────────────────────────────────────────────────────────────────────────

/** True for the SDK's answer to a missing object: NoSuchKey on GET, NotFound (a bare 404) on HEAD. */
function isMissingS3Object(e: unknown): boolean {
	const err = e as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
	return err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404;
}

/** The S3-compatible backend. The SDK loads only when this backend is chosen, so the default
 *  deployment never loads it. */
async function s3Backend(): Promise<CustodialBackend> {
	const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, paginateListObjectsV2 } =
		await import("@aws-sdk/client-s3");
	const Bucket = config.CUSTODIAL_S3_BUCKET!.trim();
	const endpoint = config.CUSTODIAL_S3_ENDPOINT?.trim() || undefined;
	const pathStyle = config.CUSTODIAL_S3_FORCE_PATH_STYLE?.trim();
	// No credentials passed: the SDK's default chain finds them (env keys, a profile, a task or instance role).
	const client = new S3Client({
		endpoint,
		region: config.CUSTODIAL_S3_REGION?.trim() || undefined,
		// Most S3-compatible servers (MinIO, Garage, Ceph) address a bucket by path, AWS by host.
		forcePathStyle: endpoint ? pathStyle !== "false" : pathStyle === "true",
	});
	return {
		kind: "s3",
		async get(objectPath) {
			assertSafeKey(objectPath);
			try {
				const res = await client.send(new GetObjectCommand({ Bucket, Key: objectPath }));
				return new Blob([(await res.Body!.transformToByteArray()) as BlobPart]);
			} catch (e) {
				if (isMissingS3Object(e)) return null;
				throw e;
			}
		},
		async put(objectPath, content, opts) {
			assertSafeKey(objectPath);
			const Body = new Uint8Array(await content.arrayBuffer());
			await client.send(new PutObjectCommand({ Bucket, Key: objectPath, Body }), { abortSignal: opts?.signal });
		},
		async delete(objectPath) {
			assertSafeKey(objectPath);
			await client.send(new DeleteObjectCommand({ Bucket, Key: objectPath }));
		},
		async *list(prefix) {
			// "" is the whole bucket, which the backup job lists.
			if (prefix) assertSafeKey(prefix.replace(/\/$/, ""));
			for await (const page of paginateListObjectsV2({ client }, { Bucket, Prefix: prefix })) {
				for (const o of page.Contents ?? []) {
					if (o.Key) yield { type: "file", path: o.Key, size: o.Size ?? 0, uploadedAt: o.LastModified?.toISOString() };
				}
			}
		},
		async stat(objectPath) {
			assertSafeKey(objectPath);
			try {
				const head = await client.send(new HeadObjectCommand({ Bucket, Key: objectPath }));
				return { type: "file", path: objectPath, size: head.ContentLength ?? 0, uploadedAt: head.LastModified?.toISOString() };
			} catch (e) {
				if (isMissingS3Object(e)) return null;
				throw e;
			}
		},
	};
}

// ── local ──────────────────────────────────────────────────────────────────────────────────────────

/** A write in progress: `<target>.<uuid>.custodial-partial`, never listed. */
const PARTIAL_SUFFIX = ".custodial-partial";
const PARTIAL_FILE = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.custodial-partial$/;

const isMissingFile = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as { code?: string } | null)?.code ?? "");

/** The local-disk backend: each object is a file at its path under `root`. */
function localBackend(root: string): CustodialBackend {
	const at = (objectPath: string) => {
		assertSafeKey(objectPath);
		return path.join(root, ...objectPath.split("/"));
	};
	const statOf = async (objectPath: string, file: string): Promise<StoredFile | null> => {
		try {
			const s = await stat(file);
			return s.isFile() ? { type: "file", path: objectPath, size: s.size, uploadedAt: s.mtime.toISOString() } : null;
		} catch (e) {
			if (isMissingFile(e)) return null;
			throw e;
		}
	};
	return {
		kind: "local",
		async get(objectPath) {
			try {
				return new Blob([(await readFile(at(objectPath))) as BlobPart]);
			} catch (e) {
				if (isMissingFile(e)) return null;
				throw e;
			}
		},
		async put(objectPath, content) {
			const file = at(objectPath);
			await mkdir(path.dirname(file), { recursive: true });
			// Written beside the target and renamed over it, so a reader never sees half a file.
			const partial = `${file}.${randomUUID()}${PARTIAL_SUFFIX}`;
			await writeFile(partial, new Uint8Array(await content.arrayBuffer()));
			await rename(partial, file);
		},
		async delete(objectPath) {
			await rm(at(objectPath), { force: true });
		},
		async *list(prefix) {
			// A prefix ends at a folder ("users/<id>/") or partway into a name; walk the folder it names.
			const folder = prefix.endsWith("/") ? prefix.slice(0, -1) : path.posix.dirname(prefix);
			const base = folder === "." || folder === "" ? root : at(folder);
			let names: string[];
			try {
				names = await readdir(base, { recursive: true });
			} catch (e) {
				if (isMissingFile(e)) return;
				throw e;
			}
			for (const name of names.sort()) {
				const objectPath = path.relative(root, path.join(base, name)).split(path.sep).join("/");
				if (!objectPath.startsWith(prefix) || PARTIAL_FILE.test(objectPath)) continue;
				const entry = await statOf(objectPath, path.join(base, name));
				if (entry) yield entry;
			}
		},
		stat: (objectPath) => statOf(objectPath, at(objectPath)),
	};
}

/** One backend per distinct setting, so a changed config (a test, a rotated bucket) gets a fresh one. */
let cached: { signature: string; backend: Promise<CustodialBackend> } | null = null;

/** This deployment's backend. Throws CustodialBackendUnsetError when none is usable. */
export function custodialBackend(): Promise<CustodialBackend> {
	const reason = unusableReason();
	const kind = configuredKind();
	if (reason || typeof kind !== "string") {
		// The hf backend keeps its own refusal, which names production's bucket.
		if (kind === "hf-bucket") {
			custodialBucketRepo();
			hubAuth();
		}
		throw new CustodialBackendUnsetError(`custodial storage is unavailable: ${reason}`);
	}
	if (kind === "hf-bucket") return Promise.resolve(hfBucketBackend);
	const signature = JSON.stringify([
		kind,
		config.CUSTODIAL_S3_BUCKET,
		config.CUSTODIAL_S3_ENDPOINT,
		config.CUSTODIAL_S3_REGION,
		config.CUSTODIAL_S3_FORCE_PATH_STYLE,
		config.CUSTODIAL_LOCAL_DIR,
	]);
	if (cached?.signature !== signature) {
		cached = { signature, backend: kind === "s3" ? s3Backend() : Promise.resolve(localBackend(config.CUSTODIAL_LOCAL_DIR!.trim())) };
	}
	return cached.backend;
}
