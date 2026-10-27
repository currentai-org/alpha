// Copy or move one file from one storage location to another. The bytes pass through our
// server, because no provider copies across accounts: @huggingface/hub's copyFile stays inside one
// namespace, and Alpha storage and a person's own bucket are two. The destination's own `write` does
// the screening (type, size, rate, CSAM scan, failing closed), so a transfer is checked exactly like
// an upload into that location. (CUR-2931)
import { CUSTODIAL_SUBFOLDERS, type CustodialSubfolder } from "../custodialBucket";
import type { UploadOptions } from "../custodialStorage";
import type { StorageLocation } from "./types";

export type TransferMode = "copy" | "move";

/** A transfer the request itself rules out: same place, too big, a name already taken, no such file. */
export class TransferRefusedError extends Error {
	name = "TransferRefusedError";
	constructor(
		message: string,
		readonly status: 400 | 404 | 409 | 413
	) {
		super(message);
	}
}

/** The copy landed but does not match the original, so a move kept both. */
export class TransferVerifyError extends Error {
	name = "TransferVerifyError";
}

/** The copy landed and matched, but the original could not be removed, so a move left both. */
export class SourceNotRemovedError extends Error {
	name = "SourceNotRemovedError";
	constructor(
		readonly copiedTo: string,
		options?: { cause?: unknown }
	) {
		super("The file was copied, but the original couldn't be removed. Both copies are there now.", options);
	}
}

/** The subfolder a path sits in, when it is one of ours; files from elsewhere land in documents/. */
function folderOf(path: string): CustodialSubfolder {
	const parent = path.split("/").at(-2) ?? "";
	return (CUSTODIAL_SUBFOLDERS as readonly string[]).includes(parent) ? (parent as CustodialSubfolder) : "documents";
}

/** What a transfer did with the name: wrote it as asked, wrote it under a free name, or found the
 *  same bytes already there and wrote nothing. */
type TransferOutcome = "copied" | "renamed" | "alreadyThere";

/** `refuse` (a single file) answers 409 for a name already taken. `keepBoth` (moving a batch, CUR-2941)
 *  never overwrites and never stops: the same bytes under that name count as already copied, and
 *  different bytes are written as `name (2).ext`, rclone's skip-if-identical plus Immich's and
 *  Nextcloud's keep-both. */
type IfNameTaken = "refuse" | "keepBoth";

/** `shapes.png` → `shapes (2).png`, the first `(n)` not in `taken`. */
function freeName(name: string, taken: ReadonlySet<string>): string {
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	for (let n = 2; ; n++) {
		const candidate = `${stem} (${n})${ext}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** The names `freeName` could have given `name`: itself and every `stem (n).ext`. */
function isNameOrNumbered(candidate: string, name: string): boolean {
	if (candidate === name) return true;
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	if (!candidate.startsWith(`${stem} (`) || !candidate.endsWith(`)${ext}`)) return false;
	return /^\d+$/.test(candidate.slice(stem.length + 2, candidate.length - ext.length - 1));
}

async function sameBytes(a: Blob, b: Blob): Promise<boolean> {
	if (a.size !== b.size) return false;
	const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
	const u = new Uint8Array(x);
	const v = new Uint8Array(y);
	for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
	return true;
}

/**
 * Copy `path` from `from` into `to`, then, for a move, delete the original. The order is fixed: copy,
 * verify the copy's size against what we read, and only then delete. A failed verify or a failed
 * delete leaves both copies in place and says so; nothing here ever deletes a source whose copy it
 * has not seen.
 * @returns the new file's path in `to`, and whether it was written under its own name, a free one, or not at all.
 */
export async function transferFile(
	from: StorageLocation,
	to: StorageLocation,
	path: string,
	mode: TransferMode,
	opts: UploadOptions,
	ifNameTaken: IfNameTaken = "refuse"
): Promise<{ path: string; outcome: TransferOutcome }> {
	if (from.id === to.id) throw new TransferRefusedError("That file is already there.", 400);
	const name = path.split("/").pop() ?? "";
	if (!name) throw new TransferRefusedError("That isn't a file.", 400);

	const limit = Math.min(from.capabilities().maxTransferBytes, to.capabilities().maxTransferBytes);
	const source = await from.stat(path);
	if (!source) throw new TransferRefusedError("That file isn't there any more.", 404);
	if (source.size > limit) {
		throw new TransferRefusedError("That file is too large to move between locations.", 413);
	}

	const folder = folderOf(path);
	const inFolder = (await to.list()).filter((f) => folderOf(f.path) === folder);
	const baseName = (p: string) => p.split("/").pop() ?? "";
	const existing = inFolder.find((f) => baseName(f.path) === name);
	// A bucket keeps no versions, so writing over a file of the same name would lose it for good.
	if (existing && ifNameTaken === "refuse") {
		throw new TransferRefusedError(`There's already a file called ${name} there.`, 409);
	}

	const content = await from.read(path);
	if (!content) throw new TransferRefusedError("That file isn't there any more.", 404);

	const sealedSizes = to.capabilities().listsSealedSizes === true;
	let writeAs = name;
	if (existing) {
		// The same bytes under this name, or under a name a previous run gave it, are already moved, so
		// a retried or repeated move writes nothing twice. Only a same-size file is read to compare.
		for (const f of inFolder) {
			if ((!sealedSizes && f.size !== content.size) || !isNameOrNumbered(baseName(f.path), name)) continue;
			const there = await to.read(f.path);
			if (there && (await sameBytes(there, content))) {
				if (mode === "move") await removeSource(from, path, f.path);
				return { path: f.path, outcome: "alreadyThere" };
			}
		}
		writeAs = freeName(name, new Set(inFolder.map((f) => baseName(f.path))));
	}

	const copied = await to.write(folder, writeAs, content, opts);

	// Size only: the two stores do not promise comparable hashes (one may report a Xet hash and the
	// other a git oid for the same bytes), and a mismatch there would keep both copies for no reason.
	// A copy is checked too, because moving a batch copies every file first and deletes the originals
	// only once all of them have landed (CUR-2941).
	// A store that lists sealed sizes is read back, since its listing counts the ciphertext.
	const landed = sealedSizes ? await to.read(copied) : await to.stat(copied);
	if (!landed || landed.size !== content.size) {
		throw new TransferVerifyError(
			mode === "copy"
				? "The copy didn't match the original. The original is unchanged."
				: "The copy didn't match the original, so the original was kept. Both copies are there now."
		);
	}

	const outcome: TransferOutcome = writeAs === name ? "copied" : "renamed";
	if (mode === "move") await removeSource(from, path, copied);
	return { path: copied, outcome };
}

async function removeSource(from: StorageLocation, path: string, copied: string): Promise<void> {
	try {
		await from.delete(path);
	} catch (e) {
		throw new SourceNotRemovedError(copied, { cause: e });
	}
}
