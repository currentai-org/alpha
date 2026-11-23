/**
 * The Open WebUI chat converter and the schema-version gate, with no database.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertChat, epochToMs, flattenContent } from "../convert";
import { readOpenWebUiSqlite, type SourceChat } from "../readSqlite";
import { KNOWN_REVISIONS, UnsupportedSourceError } from "../../../shared/openWebUiImport/sourceSchema";
import { formatReport, reportParity, userParity } from "../report";
import { buildFixture, FIXTURE_REVISION } from "./owuiFixture";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "owui-fixture-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const chat = (over: Partial<SourceChat> = {}): SourceChat => ({
	id: "c",
	userId: "u",
	title: "t",
	blob: null,
	createdAt: 1_760_000_000,
	updatedAt: 1_760_000_100,
	archived: false,
	pinned: false,
	folderId: null,
	tags: [],
	...over,
});
const row = (id: string, parentId: string | null, role: string, content: unknown, createdAt = 1_760_000_001) => ({
	id: `c-${id}`,
	chatId: "c",
	role,
	parentId,
	content,
	modelId: null,
	fileIds: [],
	createdAt,
});

describe("schema version gate", () => {
	it("refuses a database at an unknown Open WebUI revision and names the revision found", () => {
		const db = buildFixture(join(dir, "webui.db"), "deadbeef0000");
		db.close();
		expect(() => readOpenWebUiSqlite(join(dir, "webui.db"))).toThrow(UnsupportedSourceError);
		expect(() => readOpenWebUiSqlite(join(dir, "webui.db"))).toThrow(/deadbeef0000/);
	});

	it("refuses a SQLite file that is not an Open WebUI database", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(join(dir, "other.db"));
		db.exec("CREATE TABLE notes (id INTEGER)");
		db.close();
		expect(() => readOpenWebUiSqlite(join(dir, "other.db"))).toThrow(/no alembic_version table/);
	});

	it("refuses a known revision whose chat table lost a column the reader selects", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(join(dir, "cut.db"));
		db.exec("CREATE TABLE alembic_version (version_num VARCHAR(32))");
		db.exec(`INSERT INTO alembic_version VALUES ('${FIXTURE_REVISION}')`);
		db.exec("CREATE TABLE user (id TEXT, email TEXT, name TEXT, role TEXT, profile_image_url TEXT, oauth TEXT, created_at INT)");
		db.exec("CREATE TABLE chat (id TEXT, user_id TEXT)");
		db.close();
		expect(() => readOpenWebUiSqlite(join(dir, "cut.db"))).toThrow(/chat\(.*title/);
	});

	it("reads the 0.12.0 fixture and lists the pinned revision as 0.12.0", () => {
		buildFixture(join(dir, "ok.db")).close();
		const data = readOpenWebUiSqlite(join(dir, "ok.db"));
		expect(KNOWN_REVISIONS[data.revision]).toBe("Open WebUI 0.12.0");
		expect(data.users.map((u) => u.id)).toEqual(["u-alice", "u-bob", "u-carol"]);
		expect(data.chats).toHaveLength(6);
		expect(data.messageRows.get("chat-a1")).toHaveLength(7);
	});

	it("opens the source read-only: the file is unchanged by a read", () => {
		const db = buildFixture(join(dir, "ro.db"));
		db.close();
		readOpenWebUiSqlite(join(dir, "ro.db"));
		const again = readOpenWebUiSqlite(join(dir, "ro.db"));
		expect(again.chats).toHaveLength(6);
	});
});

describe("convertChat", () => {
	it("keeps a regenerated answer as a sibling branch under the same parent, ancestors root first", () => {
		const out = convertChat(
			chat(),
			[row("m1", null, "user", "q"), row("m2", "m1", "assistant", "a1", 1_760_000_002), row("m3", "m1", "assistant", "a2", 1_760_000_003)]
		);
		if (!out.ok) throw new Error(out.reason);
		const [root, q, a1, a2] = out.value.messages;
		expect(root.from).toBe("system");
		expect(root.children).toEqual([q.id]);
		expect(q.ancestors).toEqual([root.id]);
		expect(q.children).toEqual([a1.id, a2.id]);
		expect(a1.ancestors).toEqual([root.id, q.id]);
		expect(a2.ancestors).toEqual([root.id, q.id]);
		expect(a1.updates?.[0]).toMatchObject({ text: "a1", interrupted: false });
	});

	it("skips a system message and hangs its child on the nearest imported ancestor", () => {
		const out = convertChat(chat(), [row("m1", null, "user", "q"), row("s", "m1", "system", "x"), row("m2", "s", "user", "again")]);
		if (!out.ok) throw new Error(out.reason);
		expect(out.value.skipped).toEqual([{ messageId: "s", reason: 'role "system" is not imported' }]);
		const [, q, again] = out.value.messages;
		expect(again.ancestors).toEqual([out.value.messages[0].id, q.id]);
		expect(out.value.sourceMessages).toBe(3);
	});

	it("skips messages whose parents form a cycle, naming the reason, rather than looping", () => {
		const out = convertChat(chat(), [row("a", "b", "user", "x"), row("b", "a", "assistant", "y"), row("ok", null, "user", "fine")]);
		if (!out.ok) throw new Error(out.reason);
		expect(out.value.messages).toHaveLength(2);
		expect(out.value.skipped.map((s) => s.messageId).sort()).toEqual(["a", "b"]);
		expect(out.value.skipped[0].reason).toMatch(/cycle/);
	});

	it("hangs a message with a missing parent on the root", () => {
		const out = convertChat(chat(), [row("m", "gone", "user", "hi")]);
		if (!out.ok) throw new Error(out.reason);
		expect(out.value.messages[1].ancestors).toEqual([out.value.messages[0].id]);
	});

	it("gives the same ids and fingerprint on a second conversion, and a new fingerprint when a message changes", () => {
		const rows = [row("m1", null, "user", "q"), row("m2", "m1", "assistant", "a")];
		const one = convertChat(chat(), rows);
		const two = convertChat(chat(), rows);
		const edited = convertChat(chat(), [rows[0], { ...rows[1], content: "a, edited" }]);
		if (!one.ok || !two.ok || !edited.ok) throw new Error("convert failed");
		expect(two.value.messages.map((m) => m.id)).toEqual(one.value.messages.map((m) => m.id));
		expect(two.value.fingerprint).toBe(one.value.fingerprint);
		expect(edited.value.fingerprint).not.toBe(one.value.fingerprint);
	});

	it("reads the chat JSON when there are no message rows, and refuses a chat that holds neither", () => {
		const blob = { history: { messages: { x: { id: "x", parentId: null, role: "user", content: "from json", timestamp: 1_760_000_005 } } } };
		const ok = convertChat(chat({ blob }), undefined);
		if (!ok.ok) throw new Error(ok.reason);
		expect(ok.value.messages[1].content).toBe("from json");
		expect(convertChat(chat({ blob: { title: "t" } }), undefined)).toMatchObject({ ok: false });
	});

	it("flattens block content to its text and counts the blocks it could not", () => {
		expect(flattenContent([{ type: "text", text: "a" }, { type: "image_url" }, "b"])).toEqual({ text: "a\n\nb", dropped: 1 });
		expect(flattenContent(null)).toEqual({ text: "", dropped: 0 });
	});

	it("reads epoch seconds, milliseconds and nanoseconds as the same instant", () => {
		const s = 1_760_000_000;
		expect(epochToMs(s)).toBe(s * 1000);
		expect(epochToMs(s * 1000)).toBe(s * 1000);
		expect(epochToMs(s * 1e9)).toBe(s * 1000);
		expect(epochToMs(0)).toBeNull();
	});
});

describe("parity report", () => {
	const base = () => ({
		sourceId: "u",
		email: "e@example.org",
		subjectId: true,
		account: "created",
		accountNote: null,
		conversations: { in: 2, imported: 1, updated: 0, unchanged: 0, skipped: [{ id: "c2", reason: "why" }] },
		messages: { in: 5, skipped: 1, stored: 4 },
		messageSkips: [],
		attachmentSkips: [],
		files: { in: 2, imported: 1, unchanged: 0, skipped: [{ id: "f2", reason: "why" }], sidecars: 1, sidecarNotes: [] },
		tags: { in: 2, stored: 1, skipped: [{ id: "t2", reason: "why" }] },
		droppedBlocks: 0,
		parityFailures: [] as string[],
	});
	it("holds when every conversation and message is stored or skipped with a reason", () => {
		expect(userParity(base())).toBe(true);
	});
	it("reports a mismatch when a tag is neither stored nor skipped", () => {
		const u = base();
		u.tags.stored = 0;
		expect(userParity(u)).toBe(false);
		expect(formatReport({ revision: "r", dryRun: false, users: [u] })).toContain("tags:          2 in, 0 stored, 1 skipped");
	});
	it("reports a mismatch when a message is neither stored nor skipped", () => {
		const u = base();
		u.messages.stored = 3;
		expect(userParity(u)).toBe(false);
		const text = formatReport({ revision: "r", dryRun: false, users: [u] });
		expect(text).toContain("MISMATCH");
		expect(reportParity({ revision: "r", dryRun: false, users: [u] })).toBe(false);
	});
	it("reports a mismatch when an uploaded file is neither stored nor skipped", () => {
		const u = base();
		u.files.imported = 0;
		expect(userParity(u)).toBe(false);
		expect(formatReport({ revision: "r", dryRun: false, users: [u] })).toMatch(/files: +2 in, 0 imported/);
	});
});
