/**
 * GET/PUT /chat/api/v2/keys/history against the real key bucket and the real lock. The
 * route spec beside this one stubs both, so only this file shows that the store and Postgres advisory
 * lock the route runs on in a deployment keep two owners' keys apart. The bucket is the `local`
 * custodial backend in a fresh directory, the same code path a self-hosted deployment uses; the lock
 * and the PUT allowance are the real Postgres ones. Only the seal-existing-chats switch is pinned off.
 * That switch is a flag and sits outside the key store.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, rmSync, type Dirent } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Encrypter, generateHybridIdentity, identityToRecipient } from "age-encryption";

// A fresh bucket directory, made before any import resolves. PG_POOL_MAX is above one, so two PUTs at
// once each hold their own connection and only the lock can serialise them (advisoryLock.spec.ts says why).
const dir = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	process.env.PG_POOL_MAX = "4";
	return mkdtempSync(join(tmpdir(), "history-key-stateful-"));
});

// The real config with two keys answered here: the route's custodial storage becomes the local-disk
// bucket in that directory, and everything else (the database URL included) reads as it would.
vi.mock("$lib/chat/server/config", async (importOriginal) => {
	const real = await importOriginal<typeof import("$lib/chat/server/config")>();
	const local: Record<string, string> = { CUSTODIAL_STORAGE_BACKEND: "local", CUSTODIAL_LOCAL_DIR: dir };
	return {
		...real,
		config: new Proxy(real.config, {
			get: (target, prop, receiver) => (typeof prop === "string" && prop in local ? local[prop] : Reflect.get(target, prop, receiver)),
		}),
	};
});
vi.mock("$lib/chat/server/chat/sealedTurn", () => ({ conversationSealWritesOn: () => false }));

import { GET, PUT } from "./+server";
import { custodialStorageConfigured } from "$lib/chat/server/storage/custodialStorage";
import { collections } from "$lib/chat/server/database";

const URL_ = "https://alpha.test/chat/api/v2/keys/history";
// Invented 24-hex ids, fresh per run so the PUT allowance rows of an earlier run never count here.
const ALICE = randomBytes(12).toString("hex");
const BOB = randomBytes(12).toString("hex");
const asUser = (id: string) => ({ user: { _id: { toString: () => id } }, sessionId: `session-of-${id}` });

async function wrapFor(): Promise<{ wrapped: string; recipient: string }> {
	const recipient = await identityToRecipient(await generateHybridIdentity());
	const e = new Encrypter();
	e.addRecipient(await identityToRecipient(await generateHybridIdentity()));
	const wrapped = await e.encrypt(JSON.stringify({ v: 1, recipients: [] }));
	return { wrapped: Buffer.from(wrapped).toString("base64"), recipient };
}

function put(locals: object, body: object) {
	const request = new Request(URL_, { method: "PUT", body: JSON.stringify({ format: 2, ...body }), headers: { "content-type": "application/json" } });
	// @ts-expect-error - RequestEvent is heavier than this test needs
	return PUT({ locals, request, url: new URL(URL_) });
}

async function served(locals: object): Promise<{ wrapped: string; recipient: string }> {
	// @ts-expect-error - RequestEvent is heavier than this test needs
	const res = await GET({ locals, request: new Request(URL_), url: new URL(URL_) });
	return res.json();
}

/** Every file under the bucket directory, as store-relative paths. */
function storedPaths(): string[] {
	return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[])
		.filter((d) => d.isFile())
		.map((d) => path.relative(dir, path.join(d.parentPath, d.name)).split(path.sep).join("/"));
}

beforeAll(() => {
	// The guard that matters: without it a misread environment would leave the route answering 503
	// and every assertion below would test the refusal and say nothing about the store.
	expect(custodialStorageConfigured(), "the local custodial bucket is not configured, so this spec would test nothing").toBe(true);
});

afterAll(async () => {
	await collections.messageEvents.deleteMany({ type: "historyKeyPut" });
	rmSync(dir, { recursive: true, force: true });
});

describe("history key route on the real bucket and lock: each session reads back only its own key", () => {
	it("two signed-in sessions each write a key at once, then each reads back exactly its own wrap and recipient", async () => {
		const alice = await wrapFor();
		const bob = await wrapFor();

		const [a, b] = await Promise.all([put(asUser(ALICE), alice), put(asUser(BOB), bob)]);
		expect([a.status, b.status]).toEqual([201, 201]);

		expect(await served(asUser(ALICE))).toMatchObject(alice);
		expect(await served(asUser(BOB))).toMatchObject(bob);

		// On disk, every key object sits under its own owner's name, and no object names both.
		const keyFiles = storedPaths().filter((p) => p.startsWith("_keys/"));
		expect(keyFiles.some((p) => p.includes(ALICE))).toBe(true);
		expect(keyFiles.some((p) => p.includes(BOB))).toBe(true);
		expect(keyFiles.filter((p) => p.includes(ALICE) && p.includes(BOB))).toEqual([]);
	});

	it("a third session with no key gets 404, not either stored owner's key", async () => {
		const carol = randomBytes(12).toString("hex");
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await expect(GET({ locals: asUser(carol), request: new Request(URL_), url: new URL(URL_) })).rejects.toMatchObject({ status: 404 });
	});
});
