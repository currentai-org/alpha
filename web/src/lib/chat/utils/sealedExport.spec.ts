import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import {
	conversationMarkdown,
	exportEnvelope,
	exportedConversation,
	readableName,
	type ExportEnvelope,
} from "$lib/chat/shared/exportFormat";
import { toOpenWebUiChat } from "$lib/chat/shared/openWebUiImport/chatFile";
import { toThunderbolt } from "$lib/chat/server/thunderboltExport";
import {
	openForExport,
	patchExportZip,
	patchOpenWebUiFile,
	patchThunderboltFile,
	SealedExportError,
	type OpenedForExport,
	type StoredSealedConversation,
} from "./sealedExport";

const CANARY = "kestrel-canary-4963";
const ID = "65f000000000000000004963";
const created = new Date("2026-11-12T10:00:00Z");

const msg = (id: string, from: Message["from"], content: string, ancestors: string[] = []) =>
	({ id, from, content, ancestors, children: [], createdAt: created, updatedAt: created }) as Message;

/** The conversation as the server holds it: a sealed title and sealed messages read as empty. */
const stored = {
	_id: ID,
	title: "",
	model: "test-model",
	createdAt: created,
	updatedAt: created,
	archived: true,
	pinned: false,
	tags: ["tag-1"],
	messages: [
		msg("sys", "system", ""),
		{ ...msg("q1", "user", "", ["sys"]), sealed: "blob", sealedRev: 0 },
		{ ...msg("a1", "assistant", "", ["sys", "q1"]), sealed: "blob", sealedRev: 0 },
	],
} as unknown as Conversation;

/** The same conversation opened in the browser. */
const opened: OpenedForExport = {
	_id: ID as unknown as Conversation["_id"],
	title: `Heron ${CANARY}`,
	model: "test-model",
	createdAt: created,
	updatedAt: created,
	messages: [
		msg("sys", "system", ""),
		msg("q1", "user", `Where do herons nest? ${CANARY}`, ["sys"]),
		{
			...msg("a1", "assistant", `In tall trees. ${CANARY}`, ["sys", "q1"]),
			webSearch: { sources: [{ n: 1, title: "Herons", url: "https://example.org/herons" }] },
		} as unknown as Message,
	],
};

describe("openForExport", () => {
	const doc = { id: ID, title: "", model: "m", messages: [] } as StoredSealedConversation;

	it("refuses a locked browser with a reason, rather than exporting sealed chats empty", async () => {
		await expect(openForExport([doc], null)).rejects.toMatchObject({ reason: "locked" });
	});

	it("refuses when any sealed part does not open, and names how many", async () => {
		const open = async () => ({ id: ID, messages: [{ ...msg("q1", "user", ""), sealedState: "unreadable" as const }] });
		const err = await openForExport([doc, { ...doc, id: "other" }], "AGE-SECRET-KEY-1", open).catch((e) => e);
		expect(err).toBeInstanceOf(SealedExportError);
		expect(err.reason).toBe("unreadable");
		expect(err.message).toMatch(/^2 sealed chats could not be opened/);
	});

	it("passes nothing through, and needs no key, when there is nothing sealed", async () => {
		expect(await openForExport([], null)).toEqual([]);
	});

	it("returns the opened title and messages in the shape the export builders read", async () => {
		const open = async () => ({ id: ID, title: "Opened", messages: opened.messages });
		const [one] = await openForExport([{ ...doc, createdAt: created.toISOString() }], "AGE-SECRET-KEY-1", open);
		expect(String(one._id)).toBe(ID);
		expect(one.title).toBe("Opened");
		expect(one.createdAt).toEqual(created);
		expect(one.messages[1].content).toContain(CANARY);
	});
});

describe("patchExportZip", () => {
	it("writes the opened text into the readable copy and conversations.json, keeping tags and files", () => {
		const files = new Map([["q1", ["files/notes.txt"]]]);
		const entry = { ...exportedConversation(stored, files), tags: ["grant"] };
		const zip = zipSync({
			"README.md": strToU8("readme"),
			[readableName(stored)]: strToU8(conversationMarkdown(stored, files)),
			"conversations.json": strToU8(JSON.stringify(exportEnvelope("acct", [entry]))),
		});

		const out = unzipSync(patchExportZip(zip, [opened]));
		expect(out[readableName(stored)], "the empty copy named after the sealed title is still there").toBeUndefined();
		const md = strFromU8(out[readableName(opened as Conversation)]);
		expect(md).toContain(`# Heron ${CANARY}`);
		expect(md).toContain(`Where do herons nest? ${CANARY}`);
		expect(md).toContain("Attached: `files/notes.txt`");
		const json = JSON.parse(strFromU8(out["conversations.json"])) as ExportEnvelope;
		expect(json.account).toEqual({ id: "acct" });
		expect(json.conversations).toHaveLength(1);
		const [c] = json.conversations;
		expect(c.title).toBe(`Heron ${CANARY}`);
		expect(c.tags).toEqual(["grant"]);
		expect(c.messages.find((m) => m.id === "q1")).toMatchObject({ content: `Where do herons nest? ${CANARY}`, files: ["files/notes.txt"] });
		expect(c.messages.find((m) => m.id === "a1")?.sources).toEqual([{ title: "Herons", url: "https://example.org/herons" }]);
		expect(strFromU8(out["README.md"])).toBe("readme");
	});

	it("returns the ZIP untouched when nothing was sealed", () => {
		const zip = zipSync({ "README.md": strToU8("readme") });
		expect(patchExportZip(zip, [])).toBe(zip);
	});
});

describe("patchOpenWebUiFile", () => {
	it("rebuilds a sealed chat from its opened text and keeps the archive, pin and tags the server wrote", () => {
		const other = toOpenWebUiChat({ ...stored, _id: "other", title: "Plain" } as unknown as Conversation, created);
		const before = [toOpenWebUiChat(stored, created), other];
		const [after, untouched] = patchOpenWebUiFile(before, [opened], created);
		expect(untouched).toBe(other);
		expect(after.title).toBe(`Heron ${CANARY}`);
		expect(after.archived).toBe(true);
		expect(after.meta.tags).toEqual(["tag-1"]);
		expect(after.chat.history.messages.q1.content).toContain(CANARY);
		expect(after.chat.messages.map((m) => m.content).join(" ")).toContain(`In tall trees. ${CANARY}`);
	});
});

describe("patchThunderboltFile", () => {
	it("writes the opened text, sources and title into the rows the server minted, ids unchanged", () => {
		const before = toThunderbolt([exportedConversation(stored)], { id: "", email: null }, created);
		const after = patchThunderboltFile(before, [opened]);
		expect(after.tables.chat_messages.map((r) => r.id)).toEqual(before.tables.chat_messages.map((r) => r.id));
		const answer = after.tables.chat_messages.find((r) => (r.metadata?.alpha as { messageId: string }).messageId === "a1")!;
		expect(answer.content).toBe(`In tall trees. ${CANARY}`);
		expect(answer.parts).toEqual([{ type: "text", text: `In tall trees. ${CANARY}` }]);
		expect(answer.metadata?.sources).toEqual([{ index: 1, url: "https://example.org/herons", title: "Herons" }]);
		expect(after.tables.chat_threads[0].title).toBe(`Heron ${CANARY}`);
	});
});
