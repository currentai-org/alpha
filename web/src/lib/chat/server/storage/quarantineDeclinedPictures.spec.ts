// A chat turn declined under a child-safety rule takes its pictures out of the sender's reach and
// keeps them in quarantine: through the real custodial storage on the local-disk backend, with
// sealing on and the real crypto, and a faked files table.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateHybridIdentity } from "age-encryption";
import { ObjectId } from "bson";
import type { Message } from "$lib/chat/types/Message";

const H = vi.hoisted(() => ({
	cfg: {} as Record<string, string | undefined>,
	table: new Map<string, { filename: string; conversationId: string; data: Buffer; mime?: string }>(),
}));

vi.mock("$lib/chat/server/config", () => ({ config: H.cfg }));
vi.mock("$lib/chat/server/logger", () => {
	const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	return { logger: quiet, securityLogger: quiet };
});
vi.mock("$lib/chat/server/alerting", () => ({
	recordRateLimitTrip: vi.fn(() => Promise.resolve()),
	clearRateLimitTrip: vi.fn(() => Promise.resolve()),
	recordCsamMatch: vi.fn(() => Promise.resolve()),
}));
vi.mock("$lib/chat/server/moderation", () => ({ reportCsamMatchToCoop: vi.fn(), reportHitToCoop: vi.fn() }));
vi.mock("$lib/chat/server/db/advisoryLock", () => ({ withAdvisoryLock: <T>(_n: string, fn: () => Promise<T>) => fn() }));
vi.mock("$lib/chat/server/db/files", () => ({
	getFileByFilename: async (filename: string, conversationId: string) => {
		const row = H.table.get(filename);
		return row && row.conversationId === conversationId ? row : undefined;
	},
	deleteFileByFilename: async (filename: string, conversationId: string) => {
		if (H.table.get(filename)?.conversationId === conversationId) H.table.delete(filename);
	},
	putFile: vi.fn(),
}));

import {
	declineQuarantinesPictures,
	quarantineDeclinedPictures,
} from "./quarantineDeclinedPictures";
import {
	downloadCustodialFile,
	listCustodialFiles,
	readCustodialAttachment,
	storeChatAttachment,
} from "./custodialStorage";
import { attachmentPath } from "./attachmentsToCustodial";

const OWNER = "ownerUserId1";
const PIC_SHA = "a".repeat(64);
const NOTE_SHA = "b".repeat(64);
const TABLE_SHA = "c".repeat(64);

let master: string;
let dir: string;
let png: Buffer;

beforeAll(async () => {
	master = await generateHybridIdentity();
	png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#1040d0" } }).png().toBuffer();
});

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "quarantine-declined-"));
	for (const k of Object.keys(H.cfg)) delete H.cfg[k];
	Object.assign(H.cfg, {
		CUSTODIAL_STORAGE_BACKEND: "local",
		CUSTODIAL_LOCAL_DIR: dir,
		CUSTODIAL_MASTER_IDENTITIES: JSON.stringify({ k1: master }),
		CUSTODIAL_MASTER_ACTIVE: "k1",
		CUSTODIAL_SEAL_WRITES: "true",
	});
	H.table.clear();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function question(files: Message["files"]): Message {
	return { id: "q1", from: "user", content: "what is this?", files } as Message;
}

describe("a child-safety decline's pictures", () => {
	it("moves the picture out of My files into quarantine, opened, and leaves it on the message by name only", async () => {
		const conv = { _id: new ObjectId() };
		const convId = conv._id.toString();
		const picPath = attachmentPath(convId, PIC_SHA, "photo.png")!;
		const notePath = attachmentPath(convId, NOTE_SHA, "notes.txt")!;
		await storeChatAttachment({ userId: OWNER }, picPath, new Blob([png as BlobPart]));
		await storeChatAttachment({ userId: OWNER }, notePath, new Blob(["a plain note"]));
		const q = question([
			{ type: "hash", value: PIC_SHA, name: "photo.png", mime: "image/png" },
			{ type: "hash", value: NOTE_SHA, name: "notes.txt", mime: "text/plain" },
		]);

		const evidence = await quarantineDeclinedPictures({ ...conv, userId: OWNER as never }, q);

		expect(evidence).toHaveLength(1);
		expect(evidence[0]).toMatch(new RegExp(`^users/${OWNER}/quarantine/\\d+-photo\\.png$`));
		// The owner can no longer list it, read it for a turn, or download it by its old path.
		const listed = (await listCustodialFiles(OWNER)).map((f) => f.path);
		expect(listed).toEqual([`users/${OWNER}/${notePath}`]);
		expect(await readCustodialAttachment(OWNER, picPath)).toBeNull();
		await expect(downloadCustodialFile(OWNER, evidence[0])).rejects.toThrow();
		// The evidence is the picture's own bytes, unsealed, so a reviewer can open it after a wipe.
		expect(Buffer.compare(await readFile(path.join(dir, evidence[0])), png)).toBe(0);
		// The text file is not a picture and stays; the picture is a left-out file on the message.
		expect(q.files?.map((f) => f.name)).toEqual(["notes.txt"]);
		expect(q.leftOutFiles).toEqual([{ name: "photo.png", mime: "image/png" }]);
	});

	it("moves a picture the files table holds into quarantine and deletes the row the old URL would serve", async () => {
		const conv = { _id: new ObjectId() };
		const convId = conv._id.toString();
		H.table.set(`${convId}-${TABLE_SHA}`, { filename: `${convId}-${TABLE_SHA}`, conversationId: convId, data: png });
		const q = question([{ type: "hash", value: TABLE_SHA, name: "shot.png", mime: "image/png" }]);

		const evidence = await quarantineDeclinedPictures({ ...conv, userId: OWNER as never }, q);

		expect(evidence).toHaveLength(1);
		expect(H.table.has(`${convId}-${TABLE_SHA}`)).toBe(false);
		expect(Buffer.compare(await readFile(path.join(dir, evidence[0])), png)).toBe(0);
		expect(q.files).toEqual([]);
	});

	it("moves a guest's picture under the guest's own quarantine folder", async () => {
		const conv = { _id: new ObjectId(), sessionId: "guestSession1" };
		const picPath = attachmentPath(conv._id.toString(), PIC_SHA, "photo.png")!;
		await storeChatAttachment({ guestSessionId: "guestSession1" }, picPath, new Blob([png as BlobPart]));
		const q = question([{ type: "hash", value: PIC_SHA, name: "photo.png", mime: "image/png" }]);

		const evidence = await quarantineDeclinedPictures(conv, q);

		expect(evidence[0]).toMatch(/^guests\/guestSession1\/quarantine\//);
		expect(q.leftOutFiles).toHaveLength(1);
	});

	it("moves pictures only for the two child-safety rules the screen fired, never another rule or a screen that could not answer", () => {
		expect(declineQuarantinesPictures({ kind: "child_safety", auditCategory: "chat-block-child-sexual-content" })).toBe(true);
		expect(declineQuarantinesPictures({ kind: "child_safety", auditCategory: "chat-block-child-grooming" })).toBe(true);
		expect(declineQuarantinesPictures({ kind: "child_safety", unscreened: true })).toBe(false);
		expect(declineQuarantinesPictures({ kind: "content_policy", auditCategory: "chat-block-sexual" })).toBe(false);
		expect(declineQuarantinesPictures({ kind: "content_policy", auditCategory: "chat-block-harrasment" })).toBe(false);
	});
});
