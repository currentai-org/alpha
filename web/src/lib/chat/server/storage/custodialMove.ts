// The one-shot move of a deployment's custodial objects off its Hugging Face bucket into the backend
// CUSTODIAL_STORAGE_BACKEND configures. Run through scripts/move-custodial-off-hf.ts.
//
// Every object is copied byte for byte: sealed files stay sealed, and owners' key objects under
// `_keys/` are copied like any other object, so nothing here imports the crypto or could decrypt.
// An object already in the destination at the same size (and, with `verify`, the same SHA-256) is
// skipped, so a rerun copies only what an earlier run missed. One at a different size or hash is a
// conflict and is left alone: the app may have written it after the switch, and a copy of the old
// object over it would lose that write.
//
// Order matters for one case. A person's own age file uploaded before their key existed opens as
// plain bytes because its upload time is earlier than their recipient file's (storedBeforeKey in
// custodialCrypto.ts). The destination stamps each object with the time it was copied, so objects go
// across oldest first, and a recipient file never lands in the same second as the object before it
// (S3 keeps LastModified to the second). An object that fails and is copied by a later run lands
// after its owner's key, so a run with failures is worth rerunning straight away.
import { createHash } from "node:crypto";
import { type CustodialBackend, type StoredFile } from "./custodialBackend";

export type MoveTotals = {
	/** Objects in the source bucket. */
	seen: number;
	copied: number;
	skipped: number;
	/** In the destination already at a different size or hash; left as they are. */
	conflicts: number;
	failed: number;
	copiedBytes: number;
	skippedBytes: number;
	/** Failures counted by error name. Never an object path: paths carry account ids and file names. */
	failures: Record<string, number>;
	ms: number;
};

export type MoveOptions = {
	/** Count what a run would do and write nothing. */
	dryRun?: boolean;
	/** For an object already in the destination at the same size, compare SHA-256 before skipping. */
	verify?: boolean;
	/** Injected by the spec; real time otherwise. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
};

const RECIPIENT_FILE = /^_keys\/(user|guest)\/[^/]+\.recipient$/;

const sha256 = async (blob: Blob) => createHash("sha256").update(new Uint8Array(await blob.arrayBuffer())).digest("hex");

/** Oldest first; an object with no upload time goes first, then by path so a rerun walks the same order. */
function byUploadTime(a: StoredFile, b: StoredFile): number {
	const ta = a.uploadedAt ? Date.parse(a.uploadedAt) : 0;
	const tb = b.uploadedAt ? Date.parse(b.uploadedAt) : 0;
	return ta - tb || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * Copies every object in `source` into `target`, skipping what is already there. Never throws for one
 * object; returns the run's totals. Throws only when the source cannot be listed at all.
 */
export async function moveCustodialObjects(
	source: CustodialBackend,
	target: CustodialBackend,
	opts: MoveOptions = {}
): Promise<MoveTotals> {
	if (source.kind === target.kind) throw new Error(`the source and the destination are both ${source.kind}`);
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const started = now();
	const totals: MoveTotals = {
		seen: 0,
		copied: 0,
		skipped: 0,
		conflicts: 0,
		failed: 0,
		copiedBytes: 0,
		skippedBytes: 0,
		failures: {},
		ms: 0,
	};

	const objects: StoredFile[] = [];
	for await (const entry of source.list("")) objects.push(entry);
	objects.sort(byUploadTime);
	totals.seen = objects.length;

	let lastPutAt: number | null = null;
	for (const o of objects) {
		try {
			const present = await target.stat(o.path);
			if (present) {
				let same = present.size === o.size;
				if (same && opts.verify) {
					const [a, b] = await Promise.all([source.get(o.path), target.get(o.path)]);
					same = a !== null && b !== null && (await sha256(a)) === (await sha256(b));
				}
				if (same) {
					totals.skipped++;
					totals.skippedBytes += o.size;
				} else {
					totals.conflicts++;
				}
				continue;
			}
			if (opts.dryRun) {
				totals.copied++;
				totals.copiedBytes += o.size;
				continue;
			}
			const content = await source.get(o.path);
			if (!content) throw Object.assign(new Error("gone from the source while the move ran"), { name: "SourceObjectGone" });
			if (RECIPIENT_FILE.test(o.path) && lastPutAt !== null && Math.floor(lastPutAt / 1000) === Math.floor(now() / 1000)) {
				await sleep(1000 - (now() % 1000) + 5);
			}
			await target.put(o.path, content);
			lastPutAt = now();
			const written = await target.stat(o.path);
			if (written?.size !== content.size) {
				throw Object.assign(new Error("the destination holds a different size after the write"), { name: "SizeMismatchAfterWrite" });
			}
			totals.copied++;
			totals.copiedBytes += content.size;
		} catch (e) {
			totals.failed++;
			const name = (e as { name?: string } | null)?.name || "Error";
			totals.failures[name] = (totals.failures[name] ?? 0) + 1;
		}
	}
	totals.ms = now() - started;
	return totals;
}

/** One line per run, counts and bytes only. */
export function formatMoveTotals(t: MoveTotals, opts: { dryRun?: boolean; target: string }): string {
	const verb = opts.dryRun ? "would copy" : "copied";
	const failures = Object.entries(t.failures)
		.map(([name, n]) => `${name}=${n}`)
		.join(" ");
	return (
		`move-custodial-off-hf${opts.dryRun ? " (dry run)" : ""} → ${opts.target}: ` +
		`${t.seen} objects · ${verb} ${t.copied} (${t.copiedBytes} bytes) · skipped ${t.skipped} (${t.skippedBytes} bytes) · ` +
		`conflicts ${t.conflicts} · failed ${t.failed}${failures ? ` [${failures}]` : ""} · ${t.ms} ms`
	);
}
