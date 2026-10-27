/**
 * The titling model reads the visitor's first message, so the turn's receipt names it, with
 * where it ran taken from the call's own response. A call that failed names nobody. (CUR-3563)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import type { Conversation } from "$lib/chat/types/Conversation";

const call: { served?: object; fail?: boolean } = {};

vi.mock("$lib/chat/server/models", () => ({
	models: [],
	defaultModel: { id: "test-model", name: "test-model" },
	taskModel: { id: "test-model", name: "test-model" },
}));
vi.mock("$lib/chat/server/conversationTitles", () => ({ conversationTitlesEnabled: () => true }));
vi.mock("$lib/chat/server/entityCorrectionGate", () => ({ entityNameCorrectionEnabled: () => false }));
vi.mock("$lib/chat/server/assistedByGate", () => ({ assistedByEnabled: () => true }));
vi.mock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
	// eslint-disable-next-line require-yield -- a side call that answers in one return
	generateFromDefaultEndpoint: async function* (o: {
		onServed?: (s: object) => void;
		onFailure?: (k: "error") => void;
	}) {
		o.onServed?.({ requestedModel: "test-model" });
		if (call.fail) {
			o.onFailure?.("error");
			return "";
		}
		if (call.served) o.onServed?.(call.served);
		return "Opera House architect";
	},
}));

import { generateTitleForConversation } from "./title";

const conv = {
	title: "New Chat",
	model: "test-model",
	messages: [
		{ id: "u1", from: "user", content: "who designed the Sydney Opera House" },
		{ id: "a1", from: "assistant", content: "Jorn Utzon." },
	],
} as unknown as Conversation;

async function run(): Promise<MessageUpdate[]> {
	const out: MessageUpdate[] = [];
	for await (const u of generateTitleForConversation(conv, undefined)) out.push(u);
	return out;
}
const receipt = (updates: MessageUpdate[]) =>
	updates.find((u) => u.type === MessageUpdateType.RouterMetadata) as
		| { assistedBy?: Array<Record<string, string>> }
		| undefined;

describe("a model-written title names its model and recorded host on the receipt (CUR-3563)", () => {
	beforeEach(() => {
		call.served = undefined;
		call.fail = false;
	});

	it("stamps a title entry with the served model and the host the response reported", async () => {
		call.served = { model: "served-title-model", backend: "https://gw.example.org/v1" };
		expect(receipt(await run())?.assistedBy).toEqual([
			{ role: "title", model: "served-title-model", backend: "gw.example.org" },
		]);
	});

	it("names no host when the response reported none, rather than a configured one", async () => {
		expect(receipt(await run())?.assistedBy).toEqual([{ role: "title", model: "test-model" }]);
	});

	it("stamps nothing when the titling call failed both attempts", async () => {
		call.fail = true;
		expect(receipt(await run())).toBeUndefined();
	});
});
