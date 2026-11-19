/**
 * The Open WebUI importer against real Postgres. The source is the synthetic 0.12.0
 * fixture (owuiFixture.ts), read from disk exactly as the CLI reads it.
 *
 * What these pin: accounts are created first and keyed on the subject id; a rerun imports nothing;
 * a rerun after one new chat imports only that chat; a changed source message updates in place
 * without duplicating or deleting what the person added in Alpha; and the parity report's numbers
 * match what the database holds.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectId } from "bson";
import { eq } from "drizzle-orm";
import { collections } from "$lib/chat/server/database";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { shadowUserId } from "$lib/chat/server/auth";
import { cleanupTestData, createTestConversation, createTestUser } from "$lib/chat/server/api/__tests__/testHelpers";
import { ORG_OIDC_PROVIDER_ID } from "$lib/chat/server/orgOidc";
import { runImport } from "../importer";
import { readOpenWebUiSqlite } from "../readSqlite";
import { IMPORT_ORIGIN } from "../convert";
import { formatReport, reportParity, type ImportReport } from "../report";
import { importedPath, sidecarPath, type FileDeps } from "../files";
import { addChat, attachment, buildFixture, FIXTURE_FILES, NEW_CHAT } from "./owuiFixture";
import { toOpenWebUiChat } from "../chatFile";
import { readOpenWebUiChatFile } from "../readChatFile";
import { branchedConversation, treeShape } from "./alphaFixture";
import { generateHybridIdentity, identityToRecipient } from "age-encryption";
import { recipientSealer } from "$lib/chat/server/chat/sealedTurn";
import { openConversationDoc } from "$lib/chat/crypto/sealedHistory";
import { NO_HISTORY_KEY_REASON } from "../importer";
import { reportSealRefused } from "../report";

let dir: string;
let dbPath: string;

beforeEach(async () => {
	await cleanupTestData();
	dir = mkdtempSync(join(tmpdir(), "owui-import-"));
	dbPath = join(dir, "webui.db");
	buildFixture(dbPath).close();
});
afterEach(async () => {
	rmSync(dir, { recursive: true, force: true });
	await cleanupTestData();
});

const run = (opts: { dryRun?: boolean } = {}) =>
	runImport(readOpenWebUiSqlite(dbPath), { model: "fixture-model", oauthProvider: "oidc", ...opts });
const userOf = (r: ImportReport, email: string) => {
	const u = r.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
	if (!u) throw new Error(`no report for ${email}`);
	return u;
};
async function shadowOf(email: string) {
	const [row] = await getDb().select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
	return new ObjectId(await shadowUserId(row.id));
}

describe.sequential("Open WebUI import", () => {
	it("creates people first on their subject id, then imports every conversation with parity", async () => {
		const report = await run();

		const accounts = await getDb().select().from(schema.account).where(eq(schema.account.providerId, ORG_OIDC_PROVIDER_ID));
		expect(accounts.map((a) => a.accountId).sort()).toEqual(["sub-alice-001", "sub-bob-002"]);
		const people = await getDb().select().from(schema.user);
		expect(people.map((p) => p.email).sort()).toEqual(["alice@example.org", "bob@example.org", "carol@example.org"]);

		const alice = userOf(report, "Alice@Example.org");
		expect(alice.conversations).toMatchObject({ in: 3, imported: 3, updated: 0, unchanged: 0, skipped: [] });
		// 7 + 2 + 2 source messages; the system message is skipped with its reason; 10 are stored.
		expect(alice.messages).toEqual({ in: 11, skipped: 1, stored: 10 });
		expect(alice.messageSkips).toEqual([{ chatId: "chat-a1", messageId: "msys", reason: 'role "system" is not imported' }]);
		expect(alice.droppedBlocks).toBe(1);
		expect(userOf(report, "bob@example.org").conversations).toMatchObject({ in: 1, imported: 1 });
		expect(userOf(report, "carol@example.org").account).toBe("created");

		const ghost = report.users.find((u) => u.sourceId === "(no matching user row)");
		expect(ghost?.conversations.skipped).toEqual([{ id: "chat-ghost", reason: "the chat's user_id matches no user row" }]);
		expect(reportParity(report)).toBe(true);

		const aliceShadow = await shadowOf("alice@example.org");
		const convs = await collections.conversations.find({ userId: aliceShadow }).toArray();
		expect(convs).toHaveLength(3);
		const basics = convs.find((c) => c.syncClientId === "chat-a1")!;
		expect(basics.syncOrigin).toBe(IMPORT_ORIGIN);
		expect(basics.title).toBe("Potluck basics");
		expect(basics.meta?.imported).toMatchObject({ source: "open-webui", screened: false });
		// Branches kept: the question has two answers, and the drink question hangs on the second.
		const byContent = (s: string) => basics.messages.find((m) => m.content === s)!;
		const m3 = byContent("Name three dishes.");
		expect(m3.children).toHaveLength(2);
		const drink = byContent("And a drink?");
		expect(drink.ancestors?.at(-1)).toBe(byContent("Tamales, couscous and flan.").id);
		expect(basics.messages.every((m) => m.moderation === undefined)).toBe(true);
		// A chat that existed only as JSON came across too.
		expect(convs.find((c) => c.syncClientId === "chat-a2")!.messages.map((m) => m.content)).toEqual(["", "Hello from the blob", "Hello back"]);
	});

	it("a rerun on an unchanged source imports nothing and leaves the same conversations", async () => {
		await run();
		const before = await collections.conversations.find({}).toArray();
		const second = await run();

		for (const u of second.users) {
			expect(u.conversations.imported, u.email).toBe(0);
			expect(u.conversations.updated, u.email).toBe(0);
		}
		expect(userOf(second, "alice@example.org").conversations.unchanged).toBe(3);
		expect(reportParity(second)).toBe(true);
		const after = await collections.conversations.find({}).toArray();
		expect(after).toHaveLength(before.length);
		expect(after.map((c) => c._id.toString()).sort()).toEqual(before.map((c) => c._id.toString()).sort());
		expect(await getDb().select().from(schema.user)).toHaveLength(3);
	});

	it("a rerun after one new chat imports only that chat", async () => {
		await run();
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbPath);
		addChat(db, NEW_CHAT(1));
		db.close();

		const second = await run();
		const bob = userOf(second, "bob@example.org");
		expect(bob.conversations).toMatchObject({ in: 2, imported: 1, updated: 0, unchanged: 1 });
		const everyoneElse = second.users.filter((u) => u.email !== "bob@example.org");
		expect(everyoneElse.reduce((n, u) => n + u.conversations.imported + u.conversations.updated, 0)).toBe(0);
		expect(await collections.conversations.countDocuments({})).toBe(6);
		expect(reportParity(second)).toBe(true);
	});

	it("copies each person's tag rows under the same id and each chat's meta.tags to its tag list, at parity, and a rerun adds none", async () => {
		const report = await run();
		const alice = await shadowOf("alice@example.org");
		const bob = await shadowOf("bob@example.org");
		const rowsOf = async (owner: ObjectId) =>
			(await getDb().select().from(schema.conversationTags).where(eq(schema.conversationTags.userId, owner.toString())))
				.map((t) => ({ id: t.id, name: t.name, meta: t.meta }))
				.sort((x, y) => x.id.localeCompare(y.id));

		// Alice's two rows as they were, plus one named after the id a chat used with no row at the source.
		expect(await rowsOf(alice)).toEqual([
			{ id: "grant", name: "Grant", meta: { color: "green" } },
			{ id: "no_row", name: "no_row", meta: null },
			{ id: "teaching_notes", name: "Teaching notes", meta: null },
		]);
		// The same id under another person is that person's own tag.
		expect(await rowsOf(bob)).toEqual([{ id: "grant", name: "grant money", meta: null }]);

		const tagsOf = async (owner: ObjectId, chatId: string) =>
			(await collections.conversations.findOne({ userId: owner, syncClientId: chatId, syncOrigin: IMPORT_ORIGIN }))?.tags;
		expect(await tagsOf(alice, "chat-a1")).toEqual(["grant", "teaching_notes"]);
		expect(await tagsOf(alice, "chat-a3")).toEqual(["grant", "no_row"]);
		expect(await tagsOf(bob, "chat-b1")).toEqual(["grant"]);
		// The sidebar filter finds them through the column, not only the stored document.
		expect((await collections.conversations.find({ userId: alice, tags: "grant" }).toArray()).map((c) => c.syncClientId).sort()).toEqual([
			"chat-a1",
			"chat-a3",
		]);

		expect(userOf(report, "alice@example.org").tags).toEqual({ in: 2, stored: 2, skipped: [] });
		const ghost = report.users.find((u) => u.sourceId === "(no matching user row)");
		expect(ghost?.tags).toEqual({ in: 1, stored: 0, skipped: [{ id: "lost", reason: "the tag's user_id matches no user row" }] });
		expect(reportParity(report)).toBe(true);

		const again = await run();
		expect(reportParity(again)).toBe(true);
		expect(await rowsOf(alice)).toHaveLength(3);
	});

	it("a changed source message updates in place, adds no duplicate, and keeps what the person added in Alpha", async () => {
		await run();
		const bobShadow = await shadowOf("bob@example.org");
		const stored = (await collections.conversations.findOne({ userId: bobShadow, syncClientId: "chat-b1" }))!;
		const leaf = stored.messages.find((m) => m.content.startsWith("Usually"))!;
		const mine = { id: randomUUID(), from: "user" as const, content: "Thanks, added in Alpha", createdAt: new Date(), updatedAt: new Date(), ancestors: [...(leaf.ancestors ?? []), leaf.id], children: [] };
		await collections.conversations.updateOne(
			{ _id: stored._id },
			{ $set: { messages: stored.messages.map((m) => (m.id === leaf.id ? { ...m, children: [mine.id] } : m)).concat(mine) } }
		);

		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbPath);
		db.prepare("UPDATE chat_message SET content = ? WHERE id = ?").run(JSON.stringify("Usually yes, edited at the source."), "chat-b1-p2");
		db.close();

		const second = await run();
		expect(userOf(second, "bob@example.org").conversations).toMatchObject({ in: 1, imported: 0, updated: 1, unchanged: 0 });
		const convs = await collections.conversations.find({ userId: bobShadow }).toArray();
		expect(convs).toHaveLength(1);
		const texts = convs[0].messages.map((m) => m.content);
		expect(texts).toContain("Usually yes, edited at the source.");
		expect(texts).not.toContain("Usually, yes, unless made with ghee.");
		expect(texts).toContain("Thanks, added in Alpha");
		// The root, the question, the edited answer and the person's own reply.
		expect(convs[0].messages).toHaveLength(4);
		// The reply is still reachable from the root through children, not only present in the list.
		const byId = new Map(convs[0].messages.map((m) => [m.id, m]));
		const reached = new Set<string>();
		const walk = (id: string) => {
			reached.add(id);
			for (const c of byId.get(id)?.children ?? []) walk(c);
		};
		walk(convs[0].rootMessageId!);
		expect(reached.size).toBe(4);
		expect(reportParity(second)).toBe(true);
	});

	it("matches a person who already has an Alpha account on email, and links their subject id rather than making a second person", async () => {
		const baId = `ba-${randomUUID()}`;
		await getDb().insert(schema.user).values({ id: baId, name: "Bob Existing", email: "bob@example.org", emailVerified: true });
		const report = await run();

		expect(userOf(report, "bob@example.org").account).toBe("matched on email, subject id linked");
		const people = await getDb().select().from(schema.user).where(eq(schema.user.email, "bob@example.org"));
		expect(people).toHaveLength(1);
		const [link] = await getDb().select().from(schema.account).where(eq(schema.account.userId, baId));
		expect(link).toMatchObject({ providerId: ORG_OIDC_PROVIDER_ID, accountId: "sub-bob-002" });
		const shadow = new ObjectId(await shadowUserId(baId));
		expect(await collections.conversations.countDocuments({ userId: shadow })).toBe(1);

		const again = await run();
		expect(userOf(again, "bob@example.org").account).toBe("matched on subject id");
	});

	it("a rerun on an unchanged source stays at parity after the person deleted an imported message in Alpha", async () => {
		await run();
		const bobShadow = await shadowOf("bob@example.org");
		const stored = (await collections.conversations.findOne({ userId: bobShadow, syncClientId: "chat-b1" }))!;
		const answer = stored.messages.find((m) => m.content.startsWith("Usually"))!;
		await collections.conversations.updateOne(
			{ _id: stored._id },
			{ $set: { messages: stored.messages.filter((m) => m.id !== answer.id).map((m) => ({ ...m, children: (m.children ?? []).filter((c) => c !== answer.id) })) } }
		);

		const second = await run();
		expect(userOf(second, "bob@example.org").conversations).toMatchObject({ unchanged: 1, imported: 0, updated: 0 });
		expect(reportParity(second)).toBe(true);
	});

	it("imports each person's files under their own Alpha account through the upload path, and a rerun uploads none", async () => {
		const stored = new Set<string>();
		const uploads: string[] = [];
		const files: FileDeps = {
			readBytes: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]) }),
			listStored: async (account) => new Set([...stored].filter((k) => k.startsWith(`${account}:`)).map((k) => k.slice(account.length + 1))),
			storedPath: (account, path) => `users/${account}/${path}`,
			upload: async (account, path) => {
				uploads.push(`${account}:${path}`);
				stored.add(`${account}:${path}`);
			},
			extractText: async () => null,
		};
		const withFiles = () => runImport(readOpenWebUiSqlite(dbPath), { model: "fixture-model", oauthProvider: "oidc", files });

		const first = await withFiles();
		const alice = (await shadowOf("alice@example.org")).toString();
		const [pdf, md] = [importedPath(FIXTURE_FILES[0]), importedPath(FIXTURE_FILES[1])];
		expect(uploads.filter((u) => u.startsWith(`${alice}:`))).toEqual([`${alice}:${pdf}`, `${alice}:${sidecarPath(pdf)}`, `${alice}:${md}`]);
		expect(userOf(first, "alice@example.org").files).toMatchObject({ in: 2, imported: 2, unchanged: 0, skipped: [], sidecars: 1 });
		const ghost = first.users.find((u) => u.sourceId === "(no matching user row)");
		expect(ghost?.files.skipped).toEqual([{ id: FIXTURE_FILES[3].id, reason: "the file's user_id matches no user row" }]);
		expect(reportParity(first)).toBe(true);

		const before = uploads.length;
		const second = await withFiles();
		expect(uploads).toHaveLength(before);
		expect(userOf(second, "alice@example.org").files).toMatchObject({ in: 2, imported: 0, unchanged: 2 });
		expect(reportParity(second)).toBe(true);
	});

	it("without file dependencies, every file is counted and skipped with that reason, and the run stays at parity", async () => {
		const report = await run();
		expect(userOf(report, "alice@example.org").files.skipped.map((s) => s.reason)).toEqual([
			"files were not requested on this run (--no-files)",
			"files were not requested on this run (--no-files)",
		]);
		expect(reportParity(report)).toBe(true);
	});

	it("a dry run converts and counts everything and writes nothing", async () => {
		const report = await run({ dryRun: true });
		expect(report.dryRun).toBe(true);
		expect(userOf(report, "alice@example.org").messages).toEqual({ in: 11, skipped: 1, stored: 10 });
		expect(await collections.conversations.countDocuments({})).toBe(0);
		expect(await getDb().select().from(schema.user)).toHaveLength(0);
	});
});

describe.sequential("Alpha to Open WebUI's chat file and back into a fresh account", () => {
	it("every conversation arrives with the same tree, title, pin and archive state, at parity", async () => {
		const { locals } = await createTestUser();
		const fixture = branchedConversation();
		const pinned = await createTestConversation(locals, { ...fixture, pinned: true });
		const archived = await createTestConversation(locals, { title: "Put away", archived: true, messages: fixture.messages.slice(0, 3) });

		// What the export route writes: the account's conversations as stored, read back from the database.
		const stored = await collections.conversations.find({ userId: locals.user!._id }).toArray();
		const file = JSON.stringify(stored.map((c) => toOpenWebUiChat(c)));
		const report = await runImport(readOpenWebUiChatFile(file, { email: "fresh@example.org" }), { model: "fixture-model" });

		const fresh = userOf(report, "fresh@example.org");
		expect(fresh.account).toBe("created");
		expect(fresh.conversations).toMatchObject({ in: 2, imported: 2, skipped: [] });
		expect(fresh.messages).toEqual({ in: 7, skipped: 0, stored: 7 });
		expect(reportParity(report)).toBe(true);

		const mine = await collections.conversations.find({ userId: await shadowOf("fresh@example.org") }).toArray();
		const bySource = new Map(mine.map((c) => [c.syncClientId, c]));
		const a = bySource.get(pinned._id.toString())!;
		const b = bySource.get(archived._id.toString())!;
		expect(a).toMatchObject({ title: "Round trip", pinned: true, syncOrigin: IMPORT_ORIGIN });
		expect(a.archived ?? false).toBe(false);
		expect(b).toMatchObject({ title: "Put away", archived: true });
		expect(treeShape(a.messages)).toEqual(treeShape(pinned.messages));
		expect(treeShape(b.messages)).toEqual(treeShape(archived.messages));

		// A second run of the same file changes nothing.
		const again = await runImport(readOpenWebUiChatFile(file, { email: "fresh@example.org" }), { model: "fixture-model" });
		expect(userOf(again, "fresh@example.org").conversations).toMatchObject({ in: 2, imported: 0, unchanged: 2 });
	});
});

describe.sequential("a message keeps the files it carried", () => {
	/** An in-memory store standing in for Alpha storage; `unreadable` file ids fail to read, as a missing upload does. */
	const attachDeps = (unreadable: string[] = []) => {
		const stored = new Set<string>();
		const files: FileDeps = {
			readBytes: async (f) => (unreadable.includes(f.id) ? { ok: false, reason: "not found in uploads" } : { ok: true, bytes: new TextEncoder().encode(`bytes of ${f.filename}`) }),
			listStored: async (account) => new Set([...stored].filter((k) => k.startsWith(`${account}:`)).map((k) => k.slice(account.length + 1))),
			storedPath: (account, path) => `users/${account}/${path}`,
			upload: async (account, path) => void stored.add(`${account}:${path}`),
			extractText: async () => null,
		};
		return files;
	};
	const withFiles = (files: FileDeps) => runImport(readOpenWebUiSqlite(dbPath), { model: "fixture-model", oauthProvider: "oidc", files });
	async function storedMessage(email: string, chatId: string, text: string) {
		const conv = await collections.conversations.findOne({ userId: await shadowOf(email), syncClientId: chatId, syncOrigin: IMPORT_ORIGIN });
		const msg = conv?.messages.find((m) => m.content === text);
		if (!msg) throw new Error(`no stored message "${text}" in ${chatId}`);
		return msg;
	}

	it("an imported message that carried attachments holds the reference a chat attachment holds, pointing at the imported Alpha file", async () => {
		const report = await withFiles(attachDeps());
		const alice = (await shadowOf("alice@example.org")).toString();
		const msg = await storedMessage("alice@example.org", "chat-a1", "What is a potluck?");

		expect(msg.files).toHaveLength(2);
		expect(msg.files?.[0]).toMatchObject({
			type: "hash",
			name: importedPath(FIXTURE_FILES[0]).split("/").pop(),
			mime: "application/pdf",
			location: { id: "alpha", path: `users/${alice}/${importedPath(FIXTURE_FILES[0])}` },
		});
		expect(msg.files?.[0].value).toMatch(/^[0-9a-f]{64}$/);
		expect(msg.files?.[1].location?.path).toBe(`users/${alice}/${importedPath(FIXTURE_FILES[1])}`);
		expect(userOf(report, "alice@example.org").attachmentSkips).toEqual([]);
		expect(reportParity(report)).toBe(true);
	});

	it("a rerun leaves exactly one reference per attachment on each message, including after the source message changes", async () => {
		const files = attachDeps();
		await withFiles(files);
		await withFiles(files);
		const again = await storedMessage("alice@example.org", "chat-a1", "What is a potluck?");
		expect(again.files?.map((f) => f.name)).toEqual([importedPath(FIXTURE_FILES[0]), importedPath(FIXTURE_FILES[1])].map((p) => p.split("/").pop()));

		// A changed source chat takes the update path, which must replace the message's references, not add to them.
		const db = new DatabaseSync(dbPath);
		db.prepare("UPDATE chat_message SET content = ? WHERE id = 'chat-a1-m2'").run(JSON.stringify("Edited at the source."));
		db.close();
		const third = await withFiles(files);
		expect(userOf(third, "alice@example.org").conversations).toMatchObject({ updated: 1, unchanged: 2 });
		const updated = await storedMessage("alice@example.org", "chat-a1", "What is a potluck?");
		expect(updated.files).toHaveLength(2);
		expect(await collections.conversations.countDocuments({ syncOrigin: IMPORT_ORIGIN })).toBe(5);
	});

	it("a message whose file was skipped still imports with its text, and the report names the skipped file on that message", async () => {
		const report = await withFiles(attachDeps([FIXTURE_FILES[0].id]));
		const msg = await storedMessage("alice@example.org", "chat-a1", "What is a potluck?");

		expect(msg.content).toBe("What is a potluck?");
		expect(msg.files?.map((f) => f.name)).toEqual([importedPath(FIXTURE_FILES[1]).split("/").pop()]);
		const alice = userOf(report, "alice@example.org");
		expect(alice.attachmentSkips).toEqual([
			{ chatId: "chat-a1", messageId: "m1", fileId: FIXTURE_FILES[0].id, reason: "not found in uploads" },
		]);
		expect(alice.files.skipped).toEqual([{ id: FIXTURE_FILES[0].id, reason: "not found in uploads" }]);
		expect(formatReport(report)).toContain(`message m1 (chat chat-a1) imported without file ${FIXTURE_FILES[0].id}: not found in uploads`);
		expect(reportParity(report)).toBe(true);
	});

	it("without file dependencies, messages keep their text with no references and the report names each file they carried", async () => {
		const report = await run();
		const msg = await storedMessage("bob@example.org", "chat-b1", "Is dal vegan?");
		expect(msg.files).toBeUndefined();
		expect(userOf(report, "bob@example.org").attachmentSkips).toEqual([
			{ chatId: "chat-b1", messageId: "p1", fileId: FIXTURE_FILES[2].id, reason: "files were not requested on this run (--no-files)" },
		]);
	});

	it("a message never takes a reference to another person's file", async () => {
		const db = new DatabaseSync(dbPath);
		db.prepare("UPDATE chat_message SET files = ? WHERE id = 'chat-b1-p1'").run(JSON.stringify([attachment(FIXTURE_FILES[0])]));
		db.close();
		const report = await withFiles(attachDeps());
		expect((await storedMessage("bob@example.org", "chat-b1", "Is dal vegan?")).files).toBeUndefined();
		expect(userOf(report, "bob@example.org").attachmentSkips.map((s) => s.reason)).toEqual(["no file row in the source has this id"]);
	});
});

describe.sequential("Open WebUI import where history is sealed", () => {
	// Words the fixture's chats hold; none may reach `conversations.doc` in plaintext once sealed.
	const SOURCE_WORDS = ["What is a potluck?", "A shared meal where everyone brings a dish.", "Lasagne, dal and a green salad.", "Is dal vegan?"];
	const MAC_KEY = Buffer.from("44".repeat(32), "hex");

	it("seals every imported title and message to the owner's recipient, so conversations.doc holds none of their words", async () => {
		const identity = await generateHybridIdentity();
		const sealer = recipientSealer(await identityToRecipient(identity), { kid: "k0", key: MAC_KEY });
		const report = await runImport(readOpenWebUiSqlite(dbPath), {
			model: "fixture-model",
			oauthProvider: "oidc",
			sealWritesOn: () => true,
			sealerFor: async () => sealer,
		});
		expect(reportParity(report)).toBe(true);
		expect(reportSealRefused(report)).toBe(false);
		expect(userOf(report, "alice@example.org").conversations).toMatchObject({ imported: 3, skipped: [] });

		const rows = await getDb().select({ id: schema.conversations.id, doc: schema.conversations.doc }).from(schema.conversations);
		expect(rows.length).toBeGreaterThan(0);
		const raw = JSON.stringify(rows.map((r) => r.doc));
		for (const words of SOURCE_WORDS) expect(raw, `"${words}" reached conversations.doc in plaintext`).not.toContain(words);

		// Every message and title is sealed, and the owner's identity opens them back to the source's words.
		const docs = await collections.conversations.find({}).toArray();
		for (const d of docs) {
			expect(d.title, "a plaintext title was stored").toBe("");
			expect(d.sealedTitle).toBeTruthy();
			expect(d.messages.every((m) => m.sealed)).toBe(true);
		}
		const opened = await Promise.all(docs.map((d) => openConversationDoc({ ...d, id: d._id.toString() } as never, d._id.toString(), identity)));
		const texts = opened.flatMap((v) => (v as unknown as { messages: { content?: string }[] }).messages.map((m) => m.content));
		expect(texts).toContain("What is a potluck?");
		expect(texts).toContain("Lasagne, dal and a green salad.");
	});

	it("refuses, loudly and writing nothing, every chat of an owner with no history key to seal to", async () => {
		const report = await runImport(readOpenWebUiSqlite(dbPath), {
			model: "fixture-model",
			oauthProvider: "oidc",
			sealWritesOn: () => true,
			sealerFor: async () => null,
		});
		const alice = userOf(report, "alice@example.org");
		expect(alice.conversations).toMatchObject({ in: 3, imported: 0 });
		expect(alice.conversations.skipped.map((s) => s.reason)).toEqual([NO_HISTORY_KEY_REASON, NO_HISTORY_KEY_REASON, NO_HISTORY_KEY_REASON]);
		expect(alice.sealRefused).toBe(NO_HISTORY_KEY_REASON);
		expect(reportSealRefused(report)).toBe(true);
		expect(formatReport(report)).toContain("REFUSED");
		expect(await collections.conversations.countDocuments({})).toBe(0);
	});
});
