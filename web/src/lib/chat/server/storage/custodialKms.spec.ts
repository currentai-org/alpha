// The KMS master backend, through the crypto module's own entry points. AWS is faked at the
// SDK's `send`, as a key store that hands out opaque handles and refuses a Decrypt whose key or
// encryption context differs from the Encrypt's, which is the behaviour of real KMS this module
// leans on. The age side is the real library. (CUR-4136)
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Encrypter, generateHybridIdentity, identityToRecipient } from "age-encryption";

const H = vi.hoisted(() => ({
	config: {} as Record<string, string | undefined>,
	security: vi.fn(),
	info: vi.fn(),
	wrapped: new Map<string, { keyId: string; context: string; plaintext: Uint8Array }>(),
	calls: [] as { op: "Encrypt" | "Decrypt"; keyId: string; context: Record<string, string> }[],
	refuse: { name: null as string | null },
	// The role each KMS call was signed with: the OIDC role's ARN, or "default chain".
	signedAs: [] as string[],
	// Whether the owner's key lock was held during each KMS call, and every client config. (CUR-4431)
	lockHeld: false,
	callsUnderLock: [] as string[],
	clientConfigs: [] as Record<string, unknown>[],
	stsConfigs: [] as Record<string, unknown>[],
}));

vi.mock("@vercel/oidc-aws-credentials-provider", () => ({
	awsCredentialsProvider: ({ roleArn, clientConfig }: { roleArn: string; clientConfig: Record<string, unknown> }) => {
		H.stsConfigs.push(clientConfig);
		return Object.assign(async () => ({}), { roleArn });
	},
}));

vi.mock("$lib/chat/server/config", () => ({ config: H.config }));
vi.mock("$lib/chat/server/logger", () => {
	const quiet = { info: H.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	return { logger: quiet, securityLogger: { ...quiet, error: H.security } };
});

vi.mock("@aws-sdk/client-kms", () => {
	const named = (name: string) => Object.assign(new Error(name), { name });
	class EncryptCommand {
		readonly op = "Encrypt";
		constructor(readonly input: { KeyId: string; Plaintext: Uint8Array; EncryptionContext: Record<string, string> }) {}
	}
	class DecryptCommand {
		readonly op = "Decrypt";
		constructor(readonly input: { KeyId: string; CiphertextBlob: Uint8Array; EncryptionContext: Record<string, string> }) {}
	}
	class KMSClient {
		constructor(readonly cfg: { region: string; credentials?: { roleArn: string } }) {
			H.clientConfigs.push(cfg);
		}
		async send(cmd: EncryptCommand | DecryptCommand) {
			if (H.lockHeld) H.callsUnderLock.push(cmd.op);
			H.signedAs.push(this.cfg.credentials?.roleArn ?? "default chain");
			H.calls.push({ op: cmd.op as "Encrypt" | "Decrypt", keyId: cmd.input.KeyId, context: cmd.input.EncryptionContext });
			if (H.refuse.name) throw named(H.refuse.name);
			if (cmd instanceof EncryptCommand) {
				const handle = crypto.randomUUID();
				H.wrapped.set(handle, { keyId: cmd.input.KeyId, context: JSON.stringify(cmd.input.EncryptionContext), plaintext: cmd.input.Plaintext });
				return { CiphertextBlob: new TextEncoder().encode(handle) };
			}
			const w = H.wrapped.get(new TextDecoder().decode(cmd.input.CiphertextBlob));
			if (!w || w.keyId !== cmd.input.KeyId || w.context !== JSON.stringify(cmd.input.EncryptionContext)) {
				throw named("InvalidCiphertextException");
			}
			return { Plaintext: w.plaintext };
		}
	}
	return { KMSClient, EncryptCommand, DecryptCommand };
});

import {
	CustodialCryptoError,
	activeMasterKid,
	openCustodialObject,
	ownerGrant,
	ownerKeyPath,
	ownerRecipient,
	ownerRecipientPath,
	runCustodialCanary,
	type KeyBucket,
	type OwnerLock,
} from "./custodialCrypto";

const KMS_KEY = "arn:aws:kms:eu-central-1:111122223333:key/0000aaaa-bbbb-cccc-dddd-eeeeffff0000";
const OTHER_KMS_KEY = "arn:aws:kms:eu-central-1:111122223333:key/9999aaaa-bbbb-cccc-dddd-eeeeffff9999";
const alice = ownerGrant("users", "alice");
const bob = ownerGrant("users", "bob");
const lock: OwnerLock = (_name, fn) => fn();
let objects: Map<string, Uint8Array>;
const bucket: KeyBucket = {
	read: async (p) => objects.get(p) ?? null,
	write: async (p, bytes) => void objects.set(p, bytes),
};
let ageMaster: string;

async function sealTo(recipient: string, text: string): Promise<Blob> {
	const e = new Encrypter();
	e.addRecipient(recipient);
	return new Blob([(await e.encrypt(text)) as BlobPart]);
}

async function openText(grant: typeof alice, blob: Blob): Promise<string> {
	return (await openCustodialObject(grant, "conversations/c/f.txt", blob, bucket)).text();
}

async function openCode(grant: typeof alice, blob: Blob): Promise<string> {
	const err = await openCustodialObject(grant, "conversations/c/f.txt", blob, bucket).catch((e) => e);
	expect(err).toBeInstanceOf(CustodialCryptoError);
	return (err as CustodialCryptoError).code;
}

beforeAll(async () => {
	ageMaster = await generateHybridIdentity();
});

beforeEach(() => {
	for (const k of Object.keys(H.config)) delete H.config[k];
	H.config.CUSTODIAL_MASTER_KMS_KEYS = JSON.stringify({ kms1: KMS_KEY });
	H.config.CUSTODIAL_MASTER_ACTIVE = "kms1";
	objects = new Map();
	H.wrapped.clear();
	H.calls.length = 0;
	H.refuse.name = null;
	H.signedAs.length = 0;
	H.lockHeld = false;
	H.callsUnderLock.length = 0;
	H.security.mockReset();
	H.info.mockReset();
});

describe("a KMS master", () => {
	it("wraps a new owner's key with KMS bound to that owner, holds no age identity in env, and opens their sealed file", async () => {
		expect(activeMasterKid()).toBe("kms1");
		const recipient = await ownerRecipient(alice, bucket, lock);
		const keyObject = new TextDecoder().decode(objects.get(ownerKeyPath(alice)));
		expect(keyObject.startsWith("alpha-custodial-kms-v1\nkms1\n")).toBe(true);
		expect(keyObject).not.toContain("AGE-SECRET-KEY");
		expect(H.calls[0]).toEqual({ op: "Encrypt", keyId: KMS_KEY, context: { "alpha-custodial-owner": "users:alice" } });
		expect(await openText(alice, await sealTo(recipient, "alice's notes"))).toBe("alice's notes");
		expect(H.calls.at(-1)).toEqual({ op: "Decrypt", keyId: KMS_KEY, context: { "alpha-custodial-owner": "users:alice" } });
	});

	it("refuses a key object copied onto another owner's path as decrypt_failed, because KMS binds the owner", async () => {
		const recipient = await ownerRecipient(alice, bucket, lock);
		objects.set(ownerKeyPath(bob), objects.get(ownerKeyPath(alice))!);
		expect(await openCode(bob, await sealTo(recipient, "alice's notes"))).toBe("decrypt_failed");
		expect(H.security).toHaveBeenCalledOnce();
	});

	it("refuses as master_unavailable, and pages, when KMS denies the deployment's role", async () => {
		const recipient = await ownerRecipient(alice, bucket, lock);
		H.refuse.name = "AccessDeniedException";
		expect(await openCode(alice, await sealTo(recipient, "x"))).toBe("master_unavailable");
		expect(H.security).toHaveBeenCalledOnce();
	});

	it("refuses a key object naming a kid this deployment holds no KMS key for as no_identity_matched", async () => {
		const recipient = await ownerRecipient(alice, bucket, lock);
		H.config.CUSTODIAL_MASTER_KMS_KEYS = JSON.stringify({ kms2: OTHER_KMS_KEY });
		H.config.CUSTODIAL_MASTER_ACTIVE = "kms2";
		expect(await openCode(alice, await sealTo(recipient, "x"))).toBe("no_identity_matched");
	});

	it("still opens an owner whose key object an env age master wrapped, after KMS becomes the active master", async () => {
		H.config.CUSTODIAL_MASTER_IDENTITIES = JSON.stringify({ age1: ageMaster });
		H.config.CUSTODIAL_MASTER_ACTIVE = "age1";
		const recipient = await ownerRecipient(bob, bucket, lock);
		expect(new TextDecoder().decode(objects.get(ownerKeyPath(bob))).startsWith("age-encryption.org/v1")).toBe(true);
		H.config.CUSTODIAL_MASTER_ACTIVE = "kms1";
		expect(await openText(bob, await sealTo(recipient, "bob's file"))).toBe("bob's file");
		expect(H.calls.filter((c) => c.op === "Decrypt")).toHaveLength(0);
	});

	it("runs the canary through KMS, wrapping and unwrapping once", async () => {
		await runCustodialCanary();
		expect(H.info).toHaveBeenCalledWith(expect.objectContaining({ event: "custodial-canary", ok: true, kid: "kms1" }), expect.any(String));
		expect(H.calls.map((c) => c.op)).toEqual(["Encrypt", "Decrypt"]);
	});

	it("signs KMS calls with the deployment's OIDC role when CUSTODIAL_KMS_ROLE_ARN is set, and with the default chain when it is not", async () => {
		const role = "arn:aws:iam::111122223333:role/custodial-kms-preview";
		const recipient = await ownerRecipient(alice, bucket, lock);
		const wrapped = H.signedAs.splice(0);
		expect(wrapped.length).toBeGreaterThan(0);
		expect(new Set(wrapped)).toEqual(new Set(["default chain"]));
		H.config.CUSTODIAL_KMS_ROLE_ARN = role;
		expect(await openText(alice, await sealTo(recipient, "alice's notes"))).toBe("alice's notes");
		expect(H.signedAs).toEqual([role]);
	});

	it("ignores a KMS entry that is not a key ARN, leaving no master to activate", () => {
		H.config.CUSTODIAL_MASTER_KMS_KEYS = JSON.stringify({ kms1: "not-an-arn" });
		expect(activeMasterKid()).toBeNull();
	});
});

it("an owner's age recipient matches the identity KMS returns", async () => {
	const recipient = await ownerRecipient(alice, bucket, lock);
	const [, entry] = [...H.wrapped][0];
	expect(await identityToRecipient(new TextDecoder().decode(entry.plaintext))).toBe(recipient);
});

// The owner lock is a Postgres advisory lock inside a transaction, and an instance has one
// pooled connection, so a KMS call made under it stalls every other request on the instance. (CUR-4431)
describe("key creation and the owner lock", () => {
	const watchedLock: OwnerLock = async (_name, fn) => {
		H.lockHeld = true;
		try {
			return await fn();
		} finally {
			H.lockHeld = false;
		}
	};

	it("makes no KMS call while holding the owner's lock on a first write, and still opens what is sealed to the key", async () => {
		const recipient = await ownerRecipient(alice, bucket, watchedLock);
		expect(H.calls.map((c) => c.op)).toEqual(["Encrypt", "Decrypt"]);
		expect(H.callsUnderLock).toEqual([]);
		expect(await openText(alice, await sealTo(recipient, "alice's notes"))).toBe("alice's notes");
	});

	it("keeps the key another instance made while this one waited, and drops its own unused", async () => {
		const theirs = await ownerRecipient(alice, bucket, lock);
		const keyObject = objects.get(ownerKeyPath(alice));
		const recipientFile = objects.get(ownerRecipientPath(alice))!;
		// This instance read no recipient before the lock, then found one inside it.
		objects.delete(ownerRecipientPath(alice));
		const racing: OwnerLock = async (_name, fn) => {
			objects.set(ownerRecipientPath(alice), recipientFile);
			return fn();
		};
		expect(await ownerRecipient(alice, bucket, racing)).toBe(theirs);
		expect(objects.get(ownerKeyPath(alice))).toBe(keyObject);
	});

	it("logs the key it created with the time each step took", async () => {
		await ownerRecipient(alice, bucket, watchedLock);
		const line = H.info.mock.calls.map(([fields]) => fields).find((f) => f.event === "custodial-key-created");
		expect(line).toEqual(
			expect.objectContaining({
				kid: "kms1",
				ms: expect.any(Number),
				mintMs: expect.any(Number),
				wrapMs: expect.any(Number),
				checkMs: expect.any(Number),
				lockedMs: expect.any(Number),
			})
		);
	});

	it("refuses a first write as master_unavailable when KMS denies the role, writing nothing and taking no lock", async () => {
		H.refuse.name = "AccessDeniedException";
		const took: string[] = [];
		const err = await ownerRecipient(alice, bucket, async (name, fn) => (took.push(name), fn())).catch((e) => e);
		expect(err).toBeInstanceOf(CustodialCryptoError);
		expect((err as CustodialCryptoError).code).toBe("master_unavailable");
		expect(took).toEqual([]);
		expect(objects.size).toBe(0);
	});
});

it("gives every KMS call and its STS credentials a request timeout and at most two attempts", async () => {
	H.config.CUSTODIAL_KMS_ROLE_ARN = "arn:aws:iam::111122223333:role/custodial-kms-timeouts";
	H.clientConfigs.length = 0;
	H.stsConfigs.length = 0;
	await ownerRecipient(bob, bucket, lock);
	const limits = { maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 3_000 } };
	expect(H.clientConfigs).toEqual([expect.objectContaining(limits)]);
	expect(H.stsConfigs).toEqual([expect.objectContaining(limits)]);
});
