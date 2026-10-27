import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { error, errorHeld } from "$lib/chat/stores/errors";
import {
	PERSONAL_INSTRUCTIONS_KEY,
	prepromptFor,
	requestNewConversation,
} from "./createConversation";

const M = "swiss-ai/apertus-v1.5-70b";

describe("prepromptFor", () => {
	it("does not copy Personalization instructions into a new chat, since the turn reads them live (CUR-1443)", () => {
		const s = { customPrompts: { [PERSONAL_INSTRUCTIONS_KEY]: "Answer in plain words." } };
		expect(prepromptFor(M, s)).toBeUndefined();
	});

	it("still sends a per-model prompt", () => {
		expect(prepromptFor(M, { customPrompts: { [PERSONAL_INSTRUCTIONS_KEY]: "x", [M]: "per-model" } })).toBe("per-model");
	});

	it("returns undefined (not an empty string) when nothing is set, so the server keeps the model's own preprompt", () => {
		expect(prepromptFor(M, { customPrompts: {} })).toBeUndefined();
	});

	it("respects a disabled per-model prompt", () => {
		expect(prepromptFor(M, { customPrompts: { [M]: "x" }, customPromptsEnabled: { [M]: false } })).toBe("");
	});
});

describe("requestNewConversation", () => {
	const settings = { customPrompts: {} };
	afterEach(() => {
		vi.unstubAllGlobals();
		error.set(undefined);
		errorHeld.set(false);
	});
	const respond = (status: number, body: unknown) =>
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(body), { status }))
		);

	it("shows the conversation cap's own words, held, and returns null when the server refuses (CUR-2875)", async () => {
		const message =
			"You have 100 conversations and the limit is 100. Delete 1 to start a new one.";
		respond(429, { message });
		await expect(requestNewConversation("m", settings)).resolves.toBeNull();
		expect(get(error)).toBe(message);
		expect(get(errorHeld)).toBe(true);
	});

	it("does not hold the toast for a server failure, which the person cannot act on", async () => {
		respond(500, { message: "Internal Error" });
		await expect(requestNewConversation("m", settings)).resolves.toBeNull();
		expect(get(errorHeld)).toBe(false);
	});

	it("returns the new conversation's id when the server makes one", async () => {
		respond(200, { conversationId: "abc123" });
		await expect(requestNewConversation("m", settings)).resolves.toBe("abc123");
		expect(get(error)).toBeUndefined();
	});

	it("takes down a held cap refusal once a later create succeeds, so it never sits over the answer (CUR-2979)", async () => {
		respond(429, { message: "You have 100 conversations and the limit is 100. Delete 1 to start a new one." });
		await requestNewConversation("m", settings);
		respond(200, { conversationId: "abc123" });
		await expect(requestNewConversation("m", settings)).resolves.toBe("abc123");
		expect(get(error)).toBeUndefined();
		expect(get(errorHeld)).toBe(false);
	});

	it("leaves an unheld error from elsewhere alone when a create succeeds", async () => {
		error.set("Couldn't rename that conversation. Please try again.");
		respond(200, { conversationId: "abc123" });
		await requestNewConversation("m", settings);
		expect(get(error)).toBe("Couldn't rename that conversation. Please try again.");
	});
});
