/**
 * The history seal backfill against real Postgres.
 *
 * What these pin: a plaintext conversation of an owner with a history recipient comes back sealed, with
 * no word of it left in `conversations.doc`, each message's MAC the one a turn would write, and the
 * owner's identity opening it back to the same words; an owner with no recipient is counted and their
 * row is left byte for byte; a second run seals nothing; the dry run writes nothing; the run refuses
 * where sealing is off; and the unsealed count agrees with what the rows hold.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObjectId } from "bson";
import { eq } from "drizzle-orm";
import { generateHybridIdentity, identityToRecipient } from "age-encryption";
import { collections } from "$lib/chat/server/database";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { cleanupTestData, createTestConversation } from "$lib/chat/server/api/__tests__/testHelpers";
import { recipientSealer, saltedSlotMac, SealedHistoryError, splitMessage } from "$lib/chat/server/chat/sealedTurn";
import { sealedHistoryForTurn } from "$lib/chat/crypto/openedHistory";
import { openConversationDoc } from "$lib/chat/crypto/sealedHistory";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import type { Message } from "$lib/chat/types/Message";
import { BackfillRefused, countUnsealed, formatBackfillReport, runSealBackfill } from "./sealBackfill";

// Invented words and an invented 32-byte secret.
const CANARY = "canary-saffron-lighthouse-4965";
const MAC_KEY = Buffer.from("55".repeat(32), "hex");

const at = new Date("2026-11-12T10:00:00Z");
const msg = (id: string, from: Message["from"], ancestors: string[], extra: Partial<Message> = {}): Message => ({
	id,
	from,
	content: "",
	ancestors,
	children: [],
	createdAt: at,
	updatedAt: at,
	...extra,
});

const plaintextTurn = (): Message[] => [
	msg("s", "system", [], { content: "Be brief.", children: ["u1"] }),
	msg("u1", "user", ["s"], { content: `What is ${CANARY}?`, children: ["a1"] }),
	msg("a1", "assistant", ["s", "u1"], {
		content: `It is a test word, ${CANARY}.`,
		updates: [{ type: MessageUpdateType.FinalAnswer, text: `It is a test word, ${CANARY}.`, interrupted: false }],
		files: [{ type: "hash", name: `${CANARY}.txt`, value: "abc123", mime: "text/plain" }],
	}),
];

const asUser = (id: ObjectId) => ({ user: { _id: id } }) as unknown as App.Locals;
const rawDoc = async (id: ObjectId) =>
	(await getDb().select({ doc: schema.conversations.doc }).from(schema.conversations).where(eq(schema.conversations.id, id.toString())))[0]
		?.doc;

let identity: string;
let recipient: string;

beforeEach(async () => {
	await cleanupTestData();
	identity ??= await generateHybridIdentity();
	recipient ??= await identityToRecipient(identity);
});
afterEach(async () => {
	await cleanupTestData();
});

/** One enrolled owner and one with no recipient, each with a plaintext conversation. */
async function seed() {
	const enrolled = new ObjectId();
	const unenrolled = new ObjectId();
	const sealedConv = await createTestConversation(asUser(enrolled), {
		title: `About ${CANARY}`,
		preprompt: "Be brief.",
		messages: plaintextTurn(),
		rootMessageId: "s",
	});
	const plainConv = await createTestConversation(asUser(unenrolled), {
		title: `Untouched ${CANARY}`,
		messages: plaintextTurn(),
		rootMessageId: "s",
	});
	const sealer = recipientSealer(recipient, { kid: "k0", key: MAC_KEY });
	const sealerFor = async (owner: { userId?: { toString(): string } | null }) =>
		owner.userId?.toString() === enrolled.toString() ? sealer : null;
	return { sealedConv, plainConv, sealerFor };
}

describe.sequential("history seal backfill", () => {
	it("seals an enrolled owner's plaintext conversation: no canary in conversations.doc, the turn's MACs, and the owner's identity opens it", async () => {
		const { sealedConv, sealerFor } = await seed();
		const before = (await collections.conversations.findOne({ _id: sealedConv._id }))!;

		const report = await runSealBackfill({ write: true, sealWritesOn: () => true, sealerFor });
		expect(report.sealed).toEqual({ owners: 1, conversations: 1, messages: 3, titles: 1 });
		expect(report.changedMeanwhile).toBe(0);

		const raw = JSON.stringify(await rawDoc(sealedConv._id));
		expect(raw, "a plaintext word reached conversations.doc").not.toContain(CANARY);

		const after = (await collections.conversations.findOne({ _id: sealedConv._id }))!;
		expect(after.title).toBe("");
		expect(after.sealedTitle).toBeTruthy();
		expect(after.sealedTitleRev).toBe(0);
		expect(after.messages.every((m) => m.sealed && m.sealedRev === 0)).toBe(true);
		// The skeleton the turn path keeps: ids and tree links unchanged, content blanked.
		expect(after.messages.map((m) => [m.id, m.ancestors, m.children, m.content])).toEqual(
			before.messages.map((m) => [m.id, m.ancestors, m.children, ""])
		);

		const convId = sealedConv._id.toString();
		const view = await openConversationDoc({ ...after, id: convId } as never, convId, identity);

		// Each MAC is the one a turn's persist writes, over the body and the salt the browser opened from the
		// blob, so the turn path accepts this history when posted back.
		const posted = new Map((sealedHistoryForTurn(convId, after.messages.map((m) => m.id)).history ?? []).map((h) => [h.id, h]));
		for (const m of after.messages) {
			const original = JSON.parse(JSON.stringify(before.messages.find((x) => x.id === m.id)));
			const { body } = splitMessage(original);
			const salt = posted.get(m.id)?.salt;
			expect(salt).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(m.sealedMac).toBe(saltedSlotMac("k0", MAC_KEY, { kind: "message", conversationId: convId, messageId: m.id, rev: 0 }, body, salt!));
		}

		const opened = view as unknown as { title: string; messages: Message[] };
		expect(opened.title).toBe(`About ${CANARY}`);
		expect(opened.messages.map((m) => m.content)).toEqual(["Be brief.", `What is ${CANARY}?`, `It is a test word, ${CANARY}.`]);
		expect(opened.messages.find((m) => m.id === "a1")?.files?.[0].name).toBe(`${CANARY}.txt`);
		expect(opened.messages.every((m) => !m.sealedState)).toBe(true);
	});

	it("skips and counts an owner with no history recipient, and leaves their row exactly as it was", async () => {
		const { plainConv, sealerFor } = await seed();
		const before = await rawDoc(plainConv._id);

		const report = await runSealBackfill({ write: true, sealWritesOn: () => true, sealerFor });
		expect(report.noRecipient).toEqual({ owners: 1, conversations: 1, messages: 3, titles: 1 });
		expect(await rawDoc(plainConv._id)).toEqual(before);
		expect(formatBackfillReport(report)).not.toContain(CANARY);
		expect(formatBackfillReport(report)).not.toContain(plainConv._id.toString());
	});

	it("seals nothing on a second run", async () => {
		const { sealedConv, sealerFor } = await seed();
		await runSealBackfill({ write: true, sealWritesOn: () => true, sealerFor });
		const sealedOnce = await rawDoc(sealedConv._id);

		const second = await runSealBackfill({ write: true, sealWritesOn: () => true, sealerFor });
		expect(second.sealed).toMatchObject({ conversations: 0, messages: 0, titles: 0 });
		// Only the unenrolled owner's row is still a candidate.
		expect(second.scanned).toBe(1);
		expect(await rawDoc(sealedConv._id)).toEqual(sealedOnce);
	});

	it("a dry run counts what a write would seal and writes nothing", async () => {
		const { sealedConv, sealerFor } = await seed();
		const before = await rawDoc(sealedConv._id);

		const report = await runSealBackfill({ sealWritesOn: () => true, sealerFor });
		expect(report.write).toBe(false);
		expect(report.sealed).toEqual({ owners: 1, conversations: 1, messages: 3, titles: 1 });
		expect(report.prepromptsLeft).toBe(1);
		expect(await rawDoc(sealedConv._id)).toEqual(before);
	});

	it("refuses where the history-seal-writes flag is off, before reading any owner", async () => {
		const { sealedConv } = await seed();
		const before = await rawDoc(sealedConv._id);
		let asked = 0;
		await expect(
			runSealBackfill({ write: true, sealWritesOn: () => false, sealerFor: async () => (asked++, null) })
		).rejects.toBeInstanceOf(BackfillRefused);
		expect(asked).toBe(0);
		expect(await rawDoc(sealedConv._id)).toEqual(before);
	});

	it("an owner the recipient listing does not name is counted as having no recipient, and their recipient is never read", async () => {
		const { sealedConv, sealerFor } = await seed();
		const enrolledKey = `users:${(await collections.conversations.findOne({ _id: sealedConv._id }))!.userId}`;
		const read: string[] = [];
		const report = await runSealBackfill({
			sealWritesOn: () => true,
			sealerFor: async (owner) => (read.push(String(owner.userId)), sealerFor(owner)),
			recipientOwners: async () => new Set([enrolledKey]),
		});
		expect(read).toHaveLength(1);
		expect(report.sealed).toEqual({ owners: 1, conversations: 1, messages: 3, titles: 1 });
		expect(report.noRecipient).toEqual({ owners: 1, conversations: 1, messages: 3, titles: 1 });
	});

	it("an owner whose recipient read errors is still counted under ownerErrors, listed or read one by one", async () => {
		const { sealedConv, plainConv } = await seed();
		const listedKeys = new Set<string>();
		for (const c of [sealedConv, plainConv]) listedKeys.add(`users:${(await collections.conversations.findOne({ _id: c._id }))!.userId}`);
		const failing = async () => {
			throw new Error("store unavailable");
		};
		for (const recipientOwners of [async () => listedKeys, null]) {
			const before = await rawDoc(sealedConv._id);
			const report = await runSealBackfill({ write: true, sealWritesOn: () => true, sealerFor: failing, recipientOwners });
			expect(report.ownerErrors).toEqual({ owners: 2, conversations: 2, messages: 6, titles: 2 });
			expect(report.sealed).toMatchObject({ owners: 0, conversations: 0 });
			expect(await rawDoc(sealedConv._id)).toEqual(before);
		}
	});

	it("a failed recipient listing falls back to reading every owner, with the same counts", async () => {
		const { sealerFor } = await seed();
		const report = await runSealBackfill({
			sealWritesOn: () => true,
			sealerFor,
			recipientOwners: async () => {
				throw new Error("listing failed");
			},
		});
		expect(report.sealed).toEqual({ owners: 1, conversations: 1, messages: 3, titles: 1 });
		expect(report.noRecipient).toEqual({ owners: 1, conversations: 1, messages: 3, titles: 1 });
	});

	it("refuses when the deployment has no MAC key, before reading any owner, even when no owner is enrolled", async () => {
		await seed();
		let asked = 0;
		await expect(
			runSealBackfill({
				sealWritesOn: () => true,
				sealerFor: async () => (asked++, null),
				recipientOwners: async () => new Set(),
				checkMacKey: () => {
					throw new SealedHistoryError("mac_key_missing", "no MAC key");
				},
			})
		).rejects.toBeInstanceOf(BackfillRefused);
		expect(asked).toBe(0);
	});

	it("reads each owner's recipient once and never more than ownerConcurrency at once, across pages", async () => {
		const owners = Array.from({ length: 7 }, () => new ObjectId());
		for (const o of owners) {
			for (let i = 0; i < 2; i++) await createTestConversation(asUser(o), { title: "t", messages: plaintextTurn(), rootMessageId: "s" });
		}
		let inFlight = 0;
		let peak = 0;
		const reads = new Map<string, number>();
		const progress: { scanned: number; owners: number }[] = [];
		const report = await runSealBackfill({
			sealWritesOn: () => true,
			batchSize: 5,
			ownerConcurrency: 2,
			sealerFor: async (owner) => {
				const k = String(owner.userId);
				reads.set(k, (reads.get(k) ?? 0) + 1);
				peak = Math.max(peak, ++inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight -= 1;
				return null;
			},
			onProgress: (p) => progress.push({ scanned: p.scanned, owners: p.owners }),
		});
		expect([...reads.values()].every((n) => n === 1)).toBe(true);
		expect(reads.size).toBe(7);
		expect(peak).toBeLessThanOrEqual(2);
		expect(report.noRecipient).toEqual({ owners: 7, conversations: 14, messages: 42, titles: 14 });
		// A progress line per page of five, counts only.
		expect(progress.at(-1)).toEqual({ scanned: 14, owners: 7 });
		expect(progress).toHaveLength(3);
	});

	it("an owner-scoped run (onlyUserId ) seals that account's chats only, keeps every message, and leaves another enrolled owner's row as it was", async () => {
		const { sealedConv } = await seed();
		const other = new ObjectId();
		const otherConv = await createTestConversation(asUser(other), {
			title: `Someone else ${CANARY}`,
			messages: plaintextTurn(),
			rootMessageId: "s",
		});
		const otherBefore = await rawDoc(otherConv._id);
		const sealer = recipientSealer(recipient, { kid: "k0", key: MAC_KEY });
		const owner = (await collections.conversations.findOne({ _id: sealedConv._id }))!.userId!.toString();

		const report = await runSealBackfill({ write: true, sealWritesOn: () => true, sealerFor: async () => sealer, onlyUserId: owner });
		expect(report.sealed).toEqual({ owners: 1, conversations: 1, messages: 3, titles: 1 });
		expect(report.scanned).toBe(1);

		const after = (await collections.conversations.findOne({ _id: sealedConv._id }))!;
		expect(after.messages).toHaveLength(3);
		expect(after.messages.every((m) => m.sealed)).toBe(true);
		expect(JSON.stringify(await rawDoc(sealedConv._id))).not.toContain(CANARY);
		expect(await rawDoc(otherConv._id)).toEqual(otherBefore);
	});

	it("the unsealed count matches the rows before and after a write", async () => {
		const { sealerFor } = await seed();
		expect(await countUnsealed()).toEqual({ messages: 6, conversations: 2, titles: 2, preprompts: 1 });
		await runSealBackfill({ write: true, sealWritesOn: () => true, sealerFor });
		// The enrolled owner's three messages, title and preprompt are sealed.
		expect(await countUnsealed()).toEqual({ messages: 3, conversations: 1, titles: 1, preprompts: 0 });
	});
});

describe.sequential("the backfill seals the preprompt with its root message", () => {
	it("leaves no copy of the preprompt in plaintext, and a turn posting the opened preprompt passes its MAC", async () => {
		const { sealedConv, sealerFor } = await seed();
		const report = await runSealBackfill({ write: true, sealWritesOn: () => true, sealerFor });
		expect(report.prepromptsLeft).toBe(0);

		const after = (await collections.conversations.findOne({ _id: sealedConv._id }))!;
		expect(after.preprompt).toBe("");
		expect(after.sealedPreprompt).toBeTruthy();
		expect(after.sealedPrepromptMac).toMatch(/^m2\.k0\./);
		expect(JSON.stringify(await rawDoc(sealedConv._id))).not.toContain("Be brief.");

		const convId = sealedConv._id.toString();
		const view = await openConversationDoc({ ...after, id: convId } as never, convId, identity);
		expect((view as unknown as { preprompt: string }).preprompt).toBe("Be brief.");
		const posted = sealedHistoryForTurn(convId, []).sealedPreprompt!;
		expect(posted).toMatchObject({ rev: 0, text: "Be brief." });
		expect(after.sealedPrepromptMac).toBe(
			saltedSlotMac("k0", MAC_KEY, { kind: "preprompt", conversationId: convId, rev: 0 }, "Be brief.", posted.salt!)
		);
	});
});
