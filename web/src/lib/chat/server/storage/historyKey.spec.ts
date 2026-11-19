/**
 * The one listing the seal backfill reads in place of a recipient read per owner. It must name
 * every owner `storeHistoryKey` gave a recipient, under the key the backfill builds, and nobody else.
 */
import { describe, expect, it } from "vitest";
import { generateHybridIdentity, identityToRecipient } from "age-encryption";
import { ownerGrant, type KeyBucket } from "./custodialCrypto";
import { historyRecipientOwners, readHistoryHolder, storeHistoryKey } from "./historyKey";

/** An in-memory bucket that lists like a CustodialBackend: every path under a prefix, at any depth. */
function memoryBucket() {
	const objects = new Map<string, Uint8Array>();
	const bucket: KeyBucket = {
		read: async (p) => objects.get(p) ?? null,
		write: async (p, bytes) => void objects.set(p, bytes),
	};
	async function* list(prefix: string) {
		for (const path of objects.keys()) if (path.startsWith(prefix)) yield { path };
	}
	return { objects, bucket, list };
}

const noLock = <T>(_name: string, fn: () => Promise<T>) => fn();
const wrap = new TextEncoder().encode("age-encryption.org/v1\n-> stanza\n");

describe("historyRecipientOwners", () => {
	it("names every user and guest storeHistoryKey enrolled, as users:<id> and guests:<id>, and nobody without a recipient", async () => {
		const { objects, bucket, list } = memoryBucket();
		const recipient = await identityToRecipient(await generateHybridIdentity());
		await storeHistoryKey(ownerGrant("users", "u-enrolled"), bucket, noLock, { wrapped: wrap, recipient });
		await storeHistoryKey(ownerGrant("guests", "g-enrolled"), bucket, noLock, { wrapped: wrap, recipient });
		// Other key objects that share the prefix but are not a recipient.
		objects.set("_keys/user/u-files-only.age", wrap);
		objects.set("_keys/guest/g-halfway.history.age", wrap);
		objects.set("_keys/user/nested/u-deep.history.recipient", wrap);
		objects.set("users/u-file-owner/_keys/x.history.recipient", wrap);

		expect(await historyRecipientOwners(list)).toEqual(new Set(["users:u-enrolled", "guests:g-enrolled"]));
	});

	it("reads one listing per owner root, never an object", async () => {
		const prefixes: string[] = [];
		async function* list(prefix: string) {
			prefixes.push(prefix);
			yield* [];
		}
		expect(await historyRecipientOwners(list)).toEqual(new Set());
		expect(prefixes).toEqual(["_keys/user/", "_keys/guest/"]);
	});
});

describe("readHistoryHolder", () => {
	it("reads person for a key stored today and for a reset slot, and server only when the holder object says so", async () => {
		const { objects, bucket } = memoryBucket();
		const recipient = await identityToRecipient(await generateHybridIdentity());
		const grant = ownerGrant("users", "u-holder");
		await storeHistoryKey(grant, bucket, noLock, { wrapped: wrap, recipient });
		const keys = { read: bucket.read };
		expect(await readHistoryHolder(grant, keys)).toBe("person");
		objects.set("_keys/user/u-holder.history.holder", new TextEncoder().encode("server\n"));
		expect(await readHistoryHolder(grant, keys)).toBe("server");
		objects.set("_keys/user/u-holder.history.holder", new TextEncoder().encode("alpha-history-key-reset\n"));
		expect(await readHistoryHolder(grant, keys)).toBe("person");
		objects.set("_keys/user/u-holder.history.holder", new TextEncoder().encode("garbled"));
		expect(await readHistoryHolder(grant, keys)).toBe("person");
	});
});
