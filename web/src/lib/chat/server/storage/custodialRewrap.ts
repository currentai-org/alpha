// Rewraps each owner's KMS-wrapped key object from one KMS key to another (and quarterly
// rotation). Run through scripts/rewrap-custodial-kms.ts.
//
// Only the small per-owner key objects (`_keys/<user|guest>/<id>.age`) are touched; sealed files are
// never read. Each blob goes through KMS ReEncrypt, so the owner's age identity is never returned to
// this process, and nothing here imports the age library. The owner stays bound as encryption context
// on both sides, exactly as `wrapToMaster` and `unwrapWithKms` in custodialCrypto.ts bind it.
//
// Safe to stop and rerun: an object already on the target kid is counted and left alone, and the old
// wrapped copy of every object is written to `_rewrap/<old kid>/…` before the key object is replaced
// and kept (nothing here deletes it). A key object that changed between read and write (the app
// replaced or wiped the owner's key) is a conflict and is left as the app wrote it. Dry run is the
// default; nothing is written without `dryRun: false`.
//
// Counts only: an object's path carries an account id, so no path or key material is returned or logged.
import { kmsRegion, kmsReEncrypt } from "./custodialKms";
import { KEY_TOMBSTONE } from "./custodialCrypto";
import type { CustodialBackend } from "./custodialBackend";

/** The first line of a KMS-wrapped key object; see KMS_KEY_MAGIC in custodialCrypto.ts. */
const KMS_KEY_MAGIC = "alpha-custodial-kms-v1\n";
const KEY_OBJECT = /^_keys\/(user|guest)\/([^/]+)\.age$/;

export type RewrapTotals = {
	/** Key objects listed under `_keys/`. */
	seen: number;
	/** Tombstoned: the owner's key was destroyed, nothing to move. */
	tombstoned: number;
	/** Not KMS-wrapped (an age master wraps it); out of scope here and still to be moved. */
	notKms: number;
	/** Already on the target kid. */
	alreadyTarget: number;
	/** On a kid that is neither a source nor the target; left alone. */
	otherKid: number;
	/** On a source kid: moved (live run) or movable (dry run). */
	rewrapped: number;
	/** Changed under the run, or the write did not read back; left as found. */
	conflicts: number;
	failed: number;
	failures: Record<string, number>;
	/** Key objects still naming a source kid after this run. Zero is the go-ahead for dropping the old key. */
	remainingOnSource: number;
	ms: number;
};

export type RewrapOptions = {
	/** kid → KMS key ARN, as in CUSTODIAL_MASTER_KMS_KEYS. Must hold the target and every source. */
	kmsKeys: Map<string, string>;
	/** Kids to move off. */
	from: string[];
	/** Kid to move onto. */
	to: string;
	/** Default true: count and write nothing. */
	dryRun?: boolean;
	/** Injected by the spec. */
	reencrypt?: typeof kmsReEncrypt;
	now?: () => number;
};

const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

function parseKms(obj: string): { kid: string; b64: string } | null {
	const [kid, b64] = obj.slice(KMS_KEY_MAGIC.length).split("\n");
	return kid && b64 ? { kid, b64 } : null;
}

async function readAll(backend: CustodialBackend, path: string): Promise<Uint8Array | null> {
	const blob = await backend.get(path);
	return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Rewraps every key object on a `from` kid onto `to`. Never throws for one object; throws only on a
 *  bad option or when the store cannot be listed. */
export async function rewrapOwnerKeys(backend: CustodialBackend, opts: RewrapOptions): Promise<RewrapTotals> {
	const dryRun = opts.dryRun ?? true;
	const reencrypt = opts.reencrypt ?? kmsReEncrypt;
	const now = opts.now ?? Date.now;
	const started = now();
	const toArn = opts.kmsKeys.get(opts.to);
	if (!toArn || !kmsRegion(toArn)) throw new Error("the target kid names no KMS key");
	if (!opts.from.length) throw new Error("no source kid given");
	if (opts.from.includes(opts.to)) throw new Error("the target kid is also a source kid");
	for (const kid of opts.from) if (!opts.kmsKeys.get(kid)) throw new Error("a source kid names no KMS key");

	const t: RewrapTotals = {
		seen: 0, tombstoned: 0, notKms: 0, alreadyTarget: 0, otherKid: 0, rewrapped: 0,
		conflicts: 0, failed: 0, failures: {}, remainingOnSource: 0, ms: 0,
	};
	const fail = (e: unknown) => {
		t.failed++;
		const name = e instanceof Error && e.name ? e.name : "Error";
		t.failures[name] = (t.failures[name] ?? 0) + 1;
	};

	for await (const file of backend.list("_keys/")) {
		const m = KEY_OBJECT.exec(file.path);
		if (!m) continue;
		t.seen++;
		const [, kind, id] = m;
		try {
			const original = await readAll(backend, file.path);
			if (!original) continue; // removed since the listing
			const obj = text(original);
			if (obj === KEY_TOMBSTONE) { t.tombstoned++; continue; }
			if (!obj.startsWith(KMS_KEY_MAGIC)) { t.notKms++; continue; }
			const parsed = parseKms(obj);
			if (!parsed) throw Object.assign(new Error("malformed key object"), { name: "MalformedKeyObject" });
			if (parsed.kid === opts.to) { t.alreadyTarget++; continue; }
			if (!opts.from.includes(parsed.kid)) { t.otherKid++; continue; }
			if (dryRun) { t.rewrapped++; t.remainingOnSource++; continue; }

			// The old wrapped copy first, so a stopped run never loses the way back.
			await backend.put(`_rewrap/${parsed.kid}/${kind}/${id}.age`, new Blob([new Uint8Array(original)]));
			const context = { "alpha-custodial-owner": `${kind === "user" ? "users" : "guests"}:${id}` };
			const blob = await reencrypt(opts.kmsKeys.get(parsed.kid)!, toArn, Buffer.from(parsed.b64, "base64"), context);
			const next = bytes(`${KMS_KEY_MAGIC}${opts.to}\n${Buffer.from(blob).toString("base64")}\n`);

			// The app may have replaced or wiped this owner's key while KMS worked; do not write over that.
			const current = await readAll(backend, file.path);
			if (!current || !same(current, original)) { t.conflicts++; t.remainingOnSource++; continue; }
			await backend.put(file.path, new Blob([next]));
			const back = await readAll(backend, file.path);
			if (!back || !same(back, next)) { t.conflicts++; t.remainingOnSource++; continue; }
			t.rewrapped++;
		} catch (e) {
			fail(e);
			t.remainingOnSource++;
		}
	}
	t.ms = now() - started;
	return t;
}

export function formatRewrapTotals(t: RewrapTotals, o: { dryRun: boolean; from: string[]; to: string }): string {
	const verb = o.dryRun ? "would rewrap" : "rewrapped";
	const lines = [
		`${o.dryRun ? "DRY RUN: nothing written. " : ""}custodial KMS rewrap ${o.from.join(",")} -> ${o.to}`,
		`  key objects seen          ${t.seen}`,
		`  ${verb.padEnd(26)}${t.rewrapped}`,
		`  already on ${o.to}`.padEnd(28) + t.alreadyTarget,
		`  on another kid, left      ${t.otherKid}`,
		`  tombstoned                ${t.tombstoned}`,
		`  not KMS-wrapped (age)     ${t.notKms}`,
		`  conflicts                 ${t.conflicts}`,
		`  failed                    ${t.failed}${Object.keys(t.failures).length ? " " + JSON.stringify(t.failures) : ""}`,
		`  still on a source kid     ${t.remainingOnSource}`,
		`  ${t.ms} ms`,
	];
	return lines.join("\n");
}
