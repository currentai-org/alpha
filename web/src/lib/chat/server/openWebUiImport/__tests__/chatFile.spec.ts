/**
 * Alpha's conversations written as Open WebUI's chat file, and the file read back by the
 * importer, with no database. The database half (a fresh account, pins, the parity report) is in
 * importer.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { convertChat } from "../convert";
import { toOpenWebUiChat } from "../../../shared/openWebUiImport/chatFile";
import { CHAT_FILE_OWNER_ID, readOpenWebUiChatFile } from "../readChatFile";
import { CHAT_FILE_REVISION, KNOWN_REVISIONS, UnsupportedSourceError } from "../../../shared/openWebUiImport/sourceSchema";
import { branchedConversation, treeShape } from "./alphaFixture";

const owner = { email: "fresh@example.org" };

describe("Open WebUI chat file, written from Alpha", () => {
	it("pins the file to a revision the importer knows, and stamps it on every chat", () => {
		expect(KNOWN_REVISIONS[CHAT_FILE_REVISION]).toBe("Open WebUI 0.12.0");
		const entry = toOpenWebUiChat(branchedConversation());
		expect(entry.meta.alpha_export).toMatchObject({ from: "alpha", open_webui: "Open WebUI 0.12.0", revision: CHAT_FILE_REVISION });
	});

	it("writes the row Open WebUI's import reads: seconds for the row, the tree under history.messages", () => {
		const c = branchedConversation({ pinned: true });
		const entry = toOpenWebUiChat(c);
		expect(entry).toMatchObject({
			id: c._id.toString(),
			user_id: "",
			title: "Round trip",
			pinned: true,
			archived: false,
			folder_id: null,
			created_at: Math.floor(c.createdAt.getTime() / 1000),
			updated_at: Math.floor(c.updatedAt.getTime() / 1000),
		});
		const msgs = entry.chat.history.messages;
		// No system message: Open WebUI's tree starts at the first question.
		expect(Object.values(msgs).map((m) => m.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
		const q = Object.values(msgs).find((m) => m.content === "Name a soup.")!;
		expect(q.parentId).toBeNull();
		expect(q.childrenIds.map((id) => msgs[id].content)).toEqual(["Minestrone.", "Gazpacho."]);
		expect(msgs[q.childrenIds[1]].childrenIds.map((id) => msgs[id].content)).toEqual(["Is it served cold?"]);
		expect(q.timestamp).toBe(Math.floor(Date.UTC(2026, 10, 5, 12, 1) / 1000));
		expect(msgs[q.childrenIds[0]]).toMatchObject({ model: "fixture-model", done: true });
	});

	it("opens Open WebUI on the branch Alpha opens on, the newest message's", () => {
		const entry = toOpenWebUiChat(branchedConversation());
		expect(entry.chat.history.messages[entry.chat.history.currentId!].content).toBe("Yes, chilled.");
		expect(entry.chat.messages.map((m) => m.content)).toEqual(["Name a soup.", "Gazpacho.", "Is it served cold?", "Yes, chilled."]);
	});

	it("carries archive state, and writes a conversation with no messages as an empty chat", () => {
		const entry = toOpenWebUiChat(branchedConversation({ archived: true, messages: [] }));
		expect(entry.archived).toBe(true);
		expect(entry.chat.history).toEqual({ messages: {}, currentId: null });
	});
});

describe("Open WebUI chat file, read by the importer", () => {
	it("a conversation written and read back converts to the same tree, every branch included", () => {
		const c = branchedConversation({ pinned: true, archived: true });
		const source = readOpenWebUiChatFile(JSON.stringify([toOpenWebUiChat(c)]), owner);
		expect(source.revision).toBe(CHAT_FILE_REVISION);
		expect(source.users).toEqual([expect.objectContaining({ id: CHAT_FILE_OWNER_ID, email: owner.email })]);
		const [chat] = source.chats;
		expect(chat).toMatchObject({ id: c._id.toString(), userId: CHAT_FILE_OWNER_ID, title: "Round trip", pinned: true, archived: true });

		const converted = convertChat(chat, source.messageRows.get(chat.id));
		if (!converted.ok) throw new Error(converted.reason);
		expect(converted.value.skipped).toEqual([]);
		expect(converted.value.sourceMessages).toBe(5);
		expect(treeShape(converted.value.messages)).toEqual(treeShape(c.messages));
		expect(converted.value.createdAt).toEqual(c.createdAt);
	});

	it("reads a file Open WebUI wrote, which carries no version, as the pinned shape", () => {
		const fromOpenWebUi = [
			{
				id: "owui-1",
				user_id: "u",
				title: "Hello",
				chat: {
					title: "Hello",
					history: {
						currentId: "b",
						messages: {
							a: { id: "a", parentId: null, childrenIds: ["b"], role: "user", content: "Hi", timestamp: 1_760_000_000 },
							b: { id: "b", parentId: "a", childrenIds: [], role: "assistant", content: "Hello!", timestamp: 1_760_000_001 },
						},
					},
				},
				created_at: 1_760_000_000,
				updated_at: 1_760_000_001,
				archived: false,
				pinned: false,
				meta: { tags: ["food"] },
				folder_id: "f1",
			},
		];
		const source = readOpenWebUiChatFile(JSON.stringify(fromOpenWebUi), owner);
		expect(source.revision).toBe(CHAT_FILE_REVISION);
		expect(source.chats[0]).toMatchObject({ id: "owui-1", folderId: "f1", createdAt: 1_760_000_000 });
		const converted = convertChat(source.chats[0], undefined);
		if (!converted.ok) throw new Error(converted.reason);
		expect(converted.value.messages.map((m) => m.content)).toEqual(["", "Hi", "Hello!"]);
	});

	it("reads an old export that holds each chat's JSON alone", () => {
		const legacy = [{ id: "old", title: "Old", timestamp: 1_700_000_000_000, history: { messages: {} } }];
		expect(readOpenWebUiChatFile(JSON.stringify(legacy), owner).chats[0]).toMatchObject({ id: "old", title: "Old", createdAt: 1_700_000_000_000 });
	});

	it("refuses (fail loud) a file that is not a chat list, a ChatGPT export, or one stamped with an unknown revision", () => {
		expect(() => readOpenWebUiChatFile("not json", owner)).toThrow(UnsupportedSourceError);
		expect(() => readOpenWebUiChatFile(JSON.stringify({ chats: [] }), owner)).toThrow(/expected a JSON list/);
		expect(() => readOpenWebUiChatFile(JSON.stringify([{ id: "x", mapping: {} }]), owner)).toThrow(/ChatGPT export/);
		const entry = toOpenWebUiChat(branchedConversation());
		entry.meta.alpha_export.revision = "deadbeef0000";
		expect(() => readOpenWebUiChatFile(JSON.stringify([entry]), owner)).toThrow(/deadbeef0000/);
	});
});
