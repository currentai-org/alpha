/**
 * Continue in a new chat's summary names the old chat by its stored title, put there by code rather than
 * left to the model, which named the topic in none of three live runs on develop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const reply = { text: "This continues an earlier conversation.\nTrees: 14 total." };

vi.mock("$lib/chat/server/generateFromDefaultEndpoint", () => ({
	// eslint-disable-next-line require-yield -- a side call that answers in one return
	generateFromDefaultEndpoint: async function* () {
		return reply.text;
	},
}));
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: () => {}, warn: () => {} } }));

import { summariseForContinue } from "./continueSummary";
import { branchedConversation } from "./openWebUiImport/__tests__/alphaFixture";

const conv = (title?: string) => branchedConversation({ title });

describe("the Continue summary leads with the chat's title", () => {
	beforeEach(() => {
		reply.text = "This continues an earlier conversation.\nTrees: 14 total.";
	});

	it("puts the stored title in front of the model's text, so the new chat names its topic whatever the model wrote", async () => {
		expect(await summariseForContinue(conv("Linden Row Orchard plan"), undefined, undefined)).toBe(
			"Continuing “Linden Row Orchard plan”:\n\nThis continues an earlier conversation.\nTrees: 14 total."
		);
	});

	it("gives the model's text alone when the title is still the default, blank, or sealed away", async () => {
		const plain = "This continues an earlier conversation.\nTrees: 14 total.";
		for (const title of ["New Chat", "", "   ", undefined]) {
			expect(await summariseForContinue(conv(title), undefined, undefined)).toBe(plain);
		}
	});

	it("returns empty (the route's 502) when the model returned nothing, never a title with no summary under it", async () => {
		reply.text = "   ";
		expect(await summariseForContinue(conv("Linden Row Orchard plan"), undefined, undefined)).toBe("");
	});
});
