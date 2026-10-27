/**
 * A conversation whose turn carries crisis support is never titled by the model, which could
 * otherwise name it "Pensées suicidaires" in the sidebar. It gets a fixed, neutral title from the catalogs, in the
 * language the support classifier read (CUR-4093). (CUR-4095)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import type { Conversation } from "$lib/chat/types/Conversation";

const call = { count: 0 };

vi.mock("$lib/chat/server/models", () => ({
	models: [],
	defaultModel: { id: "test-model", name: "test-model" },
	taskModel: { id: "test-model", name: "test-model" },
}));
vi.mock("$lib/chat/server/conversationTitles", () => ({ conversationTitlesEnabled: () => true }));
vi.mock("$lib/chat/server/entityCorrectionGate", () => ({ entityNameCorrectionEnabled: () => false }));
vi.mock("$lib/chat/server/assistedByGate", () => ({ assistedByEnabled: () => false }));
vi.mock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
	// eslint-disable-next-line require-yield -- a side call that answers in one return
	generateFromDefaultEndpoint: async function* () {
		call.count++;
		return "Pensées suicidaires";
	},
}));

import { cannedTitleForConversation, generateTitleForConversation } from "./title";

function conv(moderation?: object): Conversation {
	return {
		title: "New Chat",
		model: "test-model",
		messages: [
			{ id: "u1", from: "user", content: "Je suis tellement fatiguée de tout." },
			{ id: "a1", from: "assistant", content: "…", ...(moderation ? { moderation } : {}) },
		],
	} as unknown as Conversation;
}
const support = (supportLang?: string) => ({
	flagged: false,
	label: null,
	score: 0,
	kind: "content_policy",
	support: true,
	...(supportLang ? { supportLang } : {}),
});

async function titles(gen: AsyncGenerator<MessageUpdate, undefined, undefined>) {
	const out: Array<{ title: string; source: string }> = [];
	for await (const u of gen) if (u.type === MessageUpdateType.Title) out.push({ title: u.title, source: u.source });
	return out;
}

describe("a support-stamped turn gets the neutral title, never the titler's output (CUR-4095)", () => {
	beforeEach(() => {
		call.count = 0;
	});

	it("writes the catalog's neutral title in the classifier's language and makes no title call", async () => {
		expect(await titles(generateTitleForConversation(conv(support("fr")), undefined))).toEqual([
			{ title: "Conversation personnelle", source: "support" },
		]);
		expect(call.count).toBe(0);
	});

	it("falls back to English for a language the catalogs do not carry", async () => {
		expect(await titles(generateTitleForConversation(conv(support("sw")), undefined))).toEqual([
			{ title: "Personal conversation", source: "support" },
		]);
		expect(call.count).toBe(0);
	});

	it("reads a region-tagged or upper-case subtag as its language", async () => {
		expect(await titles(generateTitleForConversation(conv(support("ES-mx")), undefined))).toEqual([
			{ title: "Conversación personal", source: "support" },
		]);
	});

	it("keeps the canned-reply path off the first five words too", async () => {
		expect(await titles(cannedTitleForConversation(conv(support("de"))))).toEqual([
			{ title: "Persönliches Gespräch", source: "support" },
		]);
	});

	it("leaves an unstamped turn to the titler", async () => {
		expect(await titles(generateTitleForConversation(conv(), undefined))).toEqual([
			{ title: "Pensées suicidaires", source: "model" },
		]);
		expect(call.count).toBe(1);
	});

	it("leaves a stamp with no language to the titler and its prompt rule, as the classifier contract says", async () => {
		await titles(generateTitleForConversation(conv(support()), undefined));
		expect(call.count).toBe(1);
	});

	it("waits for the classifier's late stamp before titling, so French distress the guard missed gets the neutral title (CUR-4093)", async () => {
		const c = conv({ flagged: false, label: null, score: 0, kind: "content_policy" });
		const reply = c.messages[1];
		const verdict = new Promise<boolean>((resolve) =>
			setTimeout(() => {
				Object.assign(reply.moderation!, { support: true, supportLang: "fr" });
				resolve(true);
			}, 20)
		);
		expect(await titles(generateTitleForConversation(c, undefined, verdict))).toEqual([
			{ title: "Conversation personnelle", source: "support" },
		]);
		expect(call.count).toBe(0);
	});
});
