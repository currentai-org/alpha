// preprocessMessages contract tests (Shieldstral swap plan Step 3): the endpoint projection of the
// ONE shared media pass. The load-bearing contracts: user content IS the prepared finalText (so the
// model receives exactly what the gate screened — and clipboard, expanded once in prepareTurnMedia,
// never double-expands here), user files are image SOURCE bytes only, and non-user messages pass
// through without hydration.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "bson";
import type { Message, MessageFile } from "$lib/chat/types/Message";

const { moduleDownloadFile } = vi.hoisted(() => ({ moduleDownloadFile: vi.fn() }));
vi.mock("$lib/chat/server/files/downloadFile", () => ({ downloadFile: moduleDownloadFile }));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { preprocessMessages } from "./preprocessMessages";
import { prepareTurnMedia, type PrepareTurnMediaDeps } from "../chat/prepareTurnMedia";

const convId = new ObjectId();
const CLIPBOARD_MIME = "application/vnd.chatui.clipboard";

function hashRef(sha: string, name = sha, mime = "application/octet-stream"): MessageFile {
	return { type: "hash", name, value: sha, mime };
}

const store: Record<string, { mime: string; data: Buffer; name?: string }> = {
	clip: { mime: CLIPBOARD_MIME, data: Buffer.from("CLIP_TEXT") },
	img: { mime: "image/png", data: Buffer.from("PNG:bytes") },
};

const deps: PrepareTurnMediaDeps = {
	downloadFile: vi.fn(async (sha: string) => {
		const f = store[sha];
		if (!f) throw new Error("not found");
		return {
			type: "base64" as const,
			name: f.name ?? sha,
			value: f.data.toString("base64"),
			mime: f.mime,
		};
	}) as unknown as PrepareTurnMediaDeps["downloadFile"],
	sharpImpl: vi.fn((src: Buffer) => {
		const chain = {
			resize: vi.fn(() => chain),
			jpeg: vi.fn(() => chain),
			toBuffer: vi.fn(async () => Buffer.concat([Buffer.from("S:"), src])),
		};
		return chain;
	}) as unknown as PrepareTurnMediaDeps["sharpImpl"],
};

beforeEach(() => {
	moduleDownloadFile.mockReset();
});

describe("preprocessMessages", () => {
	it("user message content is finalText and files are image sources only; clipboard no longer double-expands", async () => {
		const messages: Message[] = [
			{
				from: "user",
				id: "m1",
				content: "typed text",
				files: [hashRef("clip"), hashRef("img")],
			} as Message,
		];
		const media = await prepareTurnMedia(messages, convId, deps);
		const out = await preprocessMessages(messages, convId, media);

		expect(out).toHaveLength(1);
		// content IS the prepared finalText — clipboard expanded exactly ONCE, by prepareTurnMedia
		expect(out[0].content).toBe("CLIP_TEXT\n\ntyped text");
		expect(out[0].content.match(/CLIP_TEXT/g)).toHaveLength(1);
		// files = image SOURCE bytes only (base64, named by sha); the clipboard ref is gone
		expect(out[0].files).toEqual([
			{
				type: "base64",
				value: Buffer.from("PNG:bytes").toString("base64"),
				mime: "image/png",
				name: "img",
			},
		]);
	});

	it("non-user messages pass through unhydrated — their files are never read downstream", async () => {
		const assistantFiles = [hashRef("someSha", "gen.png", "image/png")];
		const messages: Message[] = [
			{ from: "user", id: "m1", content: "hello" } as Message,
			{ from: "assistant", id: "a1", content: "reply", files: assistantFiles } as Message,
		];
		const out = await preprocessMessages(messages, convId); // media omitted → computed internally
		// zero USER files → fast path, and assistant files are never hydrated
		expect(moduleDownloadFile).not.toHaveBeenCalled();
		expect(out[1].content).toBe("reply");
		expect(out[1].files).toEqual(assistantFiles);
	});

	it("computes the media itself when none is passed — one implementation, no duplicated hydrate path", async () => {
		const messages: Message[] = [
			{ from: "user", id: "m1", content: "just text" } as Message,
			{ from: "user", id: "m2", content: "more text" } as Message,
		];
		const out = await preprocessMessages(messages, convId);
		expect(out.map((m) => m.content)).toEqual(["just text", "more text"]);
	});

	it("strips an empty initial system message", async () => {
		const messages: Message[] = [
			{ from: "system", id: "s1", content: "   " } as Message,
			{ from: "user", id: "m1", content: "hi" } as Message,
		];
		const out = await preprocessMessages(messages, convId);
		expect(out).toHaveLength(1);
		expect(out[0].from).toBe("user");
	});

	it("keeps a non-empty system message", async () => {
		const messages: Message[] = [
			{ from: "system", id: "s1", content: "be helpful" } as Message,
			{ from: "user", id: "m1", content: "hi" } as Message,
		];
		const out = await preprocessMessages(messages, convId);
		expect(out.map((m) => m.from)).toEqual(["system", "user"]);
	});
});
