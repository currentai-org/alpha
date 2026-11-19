/**
 * A synthetic Open WebUI SQLite database at the 0.12.0 head revision. Every name, address and
 * message here is invented; nothing in it came from a real install. The tables carry the columns the
 * importer selects, in the shape the 0.12.0 migrations leave them (JSON columns are text, timestamps are
 * epoch seconds, a `chat_message` id is `{chat_id}-{message_id}`).
 */
import { DatabaseSync } from "node:sqlite";

export const FIXTURE_REVISION = "b8f2c6d91a04";
const T0 = 1_760_000_000;

const DDL = [
	"CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)",
	`CREATE TABLE user (id VARCHAR PRIMARY KEY, email VARCHAR, username VARCHAR(50), role VARCHAR, name VARCHAR NOT NULL,
		profile_image_url TEXT, oauth JSON, created_at BIGINT, updated_at BIGINT, last_active_at BIGINT)`,
	`CREATE TABLE chat (id VARCHAR PRIMARY KEY, user_id VARCHAR, title TEXT, chat JSON, created_at BIGINT, updated_at BIGINT,
		share_id TEXT, archived BOOLEAN DEFAULT 0, pinned BOOLEAN DEFAULT 0, meta JSON, folder_id TEXT, current_message_id TEXT)`,
	`CREATE TABLE chat_message (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT, role TEXT NOT NULL, parent_id TEXT,
		content JSON, output JSON, model_id TEXT, files JSON, done BOOLEAN DEFAULT 1, created_at BIGINT, updated_at BIGINT)`,
	`CREATE TABLE file (id VARCHAR PRIMARY KEY, user_id VARCHAR, hash TEXT, filename TEXT, path TEXT, data JSON, meta JSON,
		created_at BIGINT, updated_at BIGINT)`,
	"CREATE TABLE tag (id VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL, user_id VARCHAR(255) NOT NULL, meta JSON, PRIMARY KEY (id, user_id))",
];

/** The fixture's `tag` rows. Bob and Alice each have a tag with the id "grant": the key is (id, user_id). */
const FIXTURE_TAGS = [
	{ id: "grant", name: "Grant", userId: "u-alice", meta: { color: "green" } },
	{ id: "teaching_notes", name: "Teaching notes", userId: "u-alice", meta: null },
	{ id: "grant", name: "grant money", userId: "u-bob", meta: null },
	{ id: "lost", name: "Lost", userId: "u-ghost", meta: null },
] as const;

/** The uploads the fixture records. Bytes for the local ones are written by writeUploads. */
export const FIXTURE_FILES = [
	{
		id: "f1a2b3c4-0000-4000-8000-000000000001",
		userId: "u-alice",
		filename: "potluck-notes.pdf",
		path: "/app/backend/data/uploads/f1a2b3c4-0000-4000-8000-000000000001_potluck-notes.pdf",
		data: { content: "Bring a dish that serves six." },
		meta: { name: "potluck-notes.pdf", content_type: "application/pdf", size: 9 },
		at: T0 + 150,
	},
	{
		id: "f1a2b3c4-0000-4000-8000-000000000002",
		userId: "u-alice",
		filename: "menu.md",
		path: "/app/backend/data/uploads/f1a2b3c4-0000-4000-8000-000000000002_menu.md",
		data: { content: "# Menu" },
		meta: { name: "menu.md", content_type: "text/markdown", size: 6 },
		at: T0 + 160,
	},
	{
		id: "f1a2b3c4-0000-4000-8000-000000000003",
		userId: "u-bob",
		filename: "table.png",
		path: "s3://owui-fixture-bucket/uploads/f1a2b3c4-0000-4000-8000-000000000003_table.png",
		data: null,
		meta: { name: "table.png", content_type: "image/png", size: 4 },
		at: T0 + 450,
	},
	{
		id: "f1a2b3c4-0000-4000-8000-000000000004",
		userId: "u-ghost",
		filename: "orphan.txt",
		path: "/app/backend/data/uploads/f1a2b3c4-0000-4000-8000-000000000004_orphan.txt",
		data: { content: "x" },
		meta: { name: "orphan.txt", content_type: "text/plain", size: 1 },
		at: T0 + 650,
	},
] as const;

/** The bytes behind each fixture file, keyed by the file's last path segment. Invented, not real files. */
export const FIXTURE_FILE_BYTES: Record<string, Uint8Array> = Object.fromEntries(
	FIXTURE_FILES.map((f) => [f.path.split("/").pop()!, new TextEncoder().encode(`bytes of ${f.filename}`)])
);

export interface FixtureMessage {
	id: string;
	parent: string | null;
	role: string;
	content: unknown;
	at: number;
	/** The message's `files` column: entries in the shape Open WebUI keeps, naming rows of the `file` table. */
	files?: unknown;
}

/** A `files` entry for an uploaded file, as the chat UI attaches it to a message. */
export const attachment = (f: { id: string; filename: string }) => ({ type: "file", id: f.id, name: f.filename, file: { id: f.id } });

const ALICE_BRANCHED: FixtureMessage[] = [
	{ id: "m1", parent: null, role: "user", content: "What is a potluck?", at: T0 + 1, files: [attachment(FIXTURE_FILES[0]), attachment(FIXTURE_FILES[1])] },
	{ id: "m2", parent: "m1", role: "assistant", content: "A shared meal where everyone brings a dish.", at: T0 + 2 },
	{ id: "m3", parent: "m2", role: "user", content: "Name three dishes.", at: T0 + 3 },
	{ id: "m4a", parent: "m3", role: "assistant", content: "Lasagne, dal and a green salad.", at: T0 + 4 },
	{ id: "m4b", parent: "m3", role: "assistant", content: "Tamales, couscous and flan.", at: T0 + 5 },
	{ id: "msys", parent: "m4b", role: "system", content: "internal note", at: T0 + 6 },
	{ id: "m5", parent: "msys", role: "user", content: "And a drink?", at: T0 + 7 },
];

function insertChatRows(db: DatabaseSync, chatId: string, userId: string, messages: FixtureMessage[]) {
	const ins = db.prepare(
		"INSERT INTO chat_message (id, chat_id, user_id, role, parent_id, content, files, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	);
	for (const m of messages) {
		ins.run(`${chatId}-${m.id}`, chatId, userId, m.role, m.parent, JSON.stringify(m.content), m.files === undefined ? null : JSON.stringify(m.files), m.role === "assistant" ? "fixture-model" : null, m.at, m.at);
	}
}

export function addChat(
	db: DatabaseSync,
	chat: { id: string; userId: string; title: string; at: number; blob?: unknown; rows?: FixtureMessage[]; tags?: string[] }
) {
	db.prepare("INSERT INTO chat (id, user_id, title, chat, created_at, updated_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
		chat.id,
		chat.userId,
		chat.title,
		JSON.stringify(chat.blob ?? { title: chat.title }),
		chat.at,
		chat.at + 100,
		JSON.stringify({ tags: chat.tags ?? [] })
	);
	if (chat.rows) insertChatRows(db, chat.id, chat.userId, chat.rows);
}

/** Writes the fixture to `path`. Returns the open handle so a test can add a chat for a rerun. */
export function buildFixture(path: string, revision: string = FIXTURE_REVISION): DatabaseSync {
	const db = new DatabaseSync(path);
	for (const stmt of DDL) db.exec(stmt);
	db.prepare("INSERT INTO alembic_version (version_num) VALUES (?)").run(revision);
	const user = db.prepare("INSERT INTO user (id, email, role, name, oauth, created_at) VALUES (?, ?, ?, ?, ?, ?)");
	user.run("u-alice", "Alice@Example.org", "admin", "Alice Fixture", JSON.stringify({ oidc: { sub: "sub-alice-001" } }), T0);
	user.run("u-bob", "bob@example.org", "user", "Bob Fixture", JSON.stringify({ oidc: { sub: "sub-bob-002" } }), T0 + 10);
	user.run("u-carol", "carol@example.org", "user", "Carol Fixture", null, T0 + 20);

	addChat(db, { id: "chat-a1", userId: "u-alice", title: "Potluck basics", at: T0 + 100, rows: ALICE_BRANCHED, tags: ["grant", "teaching_notes"] });
	// A chat with no chat_message rows: only its own JSON holds the tree.
	addChat(db, {
		id: "chat-a2",
		userId: "u-alice",
		title: "Old chat from before the message table",
		at: T0 + 200,
		blob: {
			history: {
				currentId: "b2",
				messages: {
					b1: { id: "b1", parentId: null, childrenIds: ["b2"], role: "user", content: "Hello from the blob", timestamp: T0 + 201 },
					b2: { id: "b2", parentId: "b1", childrenIds: [], role: "assistant", content: "Hello back", timestamp: T0 + 202 },
				},
			},
		},
	});
	addChat(db, {
		id: "chat-a3",
		userId: "u-alice",
		title: "Blocks",
		at: T0 + 300,
		// "no_row" has no `tag` row at the source.
		tags: ["grant", "no_row"],
		rows: [
			{ id: "k1", parent: null, role: "user", content: [{ type: "text", text: "Describe this" }, { type: "image_url", image_url: { url: "x" } }], at: T0 + 301 },
			{ id: "k2", parent: "k1", role: "assistant", content: "I cannot see an image here.", at: T0 + 302 },
		],
	});
	addChat(db, {
		id: "chat-b1",
		userId: "u-bob",
		title: "Bob's question",
		at: T0 + 400,
		tags: ["grant"],
		rows: [
			{ id: "p1", parent: null, role: "user", content: "Is dal vegan?", at: T0 + 401, files: [attachment(FIXTURE_FILES[2])] },
			{ id: "p2", parent: "p1", role: "assistant", content: "Usually, yes, unless made with ghee.", at: T0 + 402 },
		],
	});
	addChat(db, {
		id: "chat-c1",
		userId: "u-carol",
		title: "Carol's note",
		at: T0 + 500,
		rows: [{ id: "q1", parent: null, role: "user", content: "Hi", at: T0 + 501 }],
	});
	const file = db.prepare("INSERT INTO file (id, user_id, filename, path, data, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	for (const f of FIXTURE_FILES) {
		file.run(f.id, f.userId, f.filename, f.path, f.data === null ? null : JSON.stringify(f.data), JSON.stringify(f.meta), f.at, f.at);
	}
	const tag = db.prepare("INSERT INTO tag (id, name, user_id, meta) VALUES (?, ?, ?, ?)");
	for (const t of FIXTURE_TAGS) tag.run(t.id, t.name, t.userId, t.meta === null ? null : JSON.stringify(t.meta));
	addChat(db, { id: "chat-ghost", userId: "u-ghost", title: "Owner left", at: T0 + 600, rows: [{ id: "g1", parent: null, role: "user", content: "x", at: T0 + 601 }] });
	return db;
}

export const NEW_CHAT = (n: number) => ({
	id: `chat-new-${n}`,
	userId: "u-bob",
	title: "Added after the first import",
	at: T0 + 1000 + n,
	rows: [
		{ id: "n1", parent: null, role: "user", content: "A later question", at: T0 + 1001 + n },
		{ id: "n2", parent: "n1", role: "assistant", content: "A later answer", at: T0 + 1002 + n },
	] satisfies FixtureMessage[],
});

/** The column types an Open WebUI install on Postgres has for the tables the importer reads (JSON as json, timestamps as bigint, flags as boolean). */
export const PG_COLUMN_TYPES: Record<string, Record<string, string>> = {
	alembic_version: { version_num: "varchar(32)" },
	user: {
		id: "varchar",
		email: "varchar",
		username: "varchar(50)",
		role: "varchar",
		name: "varchar",
		profile_image_url: "text",
		oauth: "json",
		created_at: "bigint",
		updated_at: "bigint",
		last_active_at: "bigint",
	},
	chat: {
		id: "varchar",
		user_id: "varchar",
		title: "text",
		chat: "json",
		created_at: "bigint",
		updated_at: "bigint",
		share_id: "text",
		archived: "boolean",
		pinned: "boolean",
		meta: "json",
		folder_id: "text",
		current_message_id: "text",
	},
	chat_message: {
		id: "text",
		chat_id: "text",
		user_id: "text",
		role: "text",
		parent_id: "text",
		content: "json",
		output: "json",
		model_id: "text",
		files: "json",
		done: "boolean",
		created_at: "bigint",
		updated_at: "bigint",
	},
	tag: { id: "varchar(255)", name: "varchar(255)", user_id: "varchar(255)", meta: "json" },
	file: { id: "varchar", user_id: "varchar", hash: "text", filename: "text", path: "text", data: "json", meta: "json", created_at: "bigint", updated_at: "bigint" },
};
