// The ranking half of past-chat search, which never touches the database. Every chat here is
// written for the test; none comes from a real conversation. (CUR-4576)
import { describe, expect, it, vi } from "vitest";
import { rankPastChats, searchPastChats } from "./pastChats";
import type { PastChat } from "../db/pastChats";

const chat = (id: string, title: string, ...messages: Array<[PastChat["messages"][number]["from"], string]>): PastChat => ({
	id,
	title,
	updatedAt: new Date("2026-10-01T00:00:00Z"),
	messages: messages.map(([from, content]) => ({ from, content })),
});

const CHATS: PastChat[] = [
	chat("c-dog", "My new dog", ["user", "My dog is a beagle called Quillon and she hates the rain."], ["assistant", "Beagles are scent hounds."]),
	chat("c-tax", "Tax question", ["user", "How do I file a tax return as a freelancer?"], ["assistant", "Keep your invoices."]),
	chat("c-soup", "Soup", ["user", "A recipe for leek soup, please."], ["assistant", "Sweat the leeks in butter."]),
];

describe("rankPastChats (CUR-4576)", () => {
	it("puts the chat that holds the asked-about word first, naming who wrote the passage", () => {
		const hits = rankPastChats("what is my dog called", CHATS);
		expect(hits[0]).toMatchObject({ conversationId: "c-dog", from: "user" });
		expect(hits[0].text).toContain("Quillon");
	});

	it("matches words in any language without a language setting", () => {
		const hits = rankPastChats("Quillon", [chat("c-fr", "Chien", ["user", "Mon chien s'appelle Quillon."])]);
		expect(hits.map((h) => h.conversationId)).toEqual(["c-fr"]);
	});

	it("returns nothing (no guess) when no word of the query occurs in any chat", () => {
		expect(rankPastChats("zeppelin", CHATS)).toEqual([]);
	});

	it("returns nothing for an empty query or an owner with no chats", () => {
		expect(rankPastChats("   ", CHATS)).toEqual([]);
		expect(rankPastChats("dog", [])).toEqual([]);
	});

	it("takes at most two passages from one chat, so one long chat cannot fill every slot", () => {
		const long = chat(
			"c-long",
			"Dogs",
			...Array.from({ length: 6 }, (_, i): ["user", string] => ["user", `dog dog dog note ${i}`])
		);
		const hits = rankPastChats("dog", [long, ...CHATS]);
		expect(hits.filter((h) => h.conversationId === "c-long").length).toBe(2);
	});
});

describe("searchPastChats (CUR-4576)", () => {
	it("gives a guest nothing and never reads the database for one", async () => {
		const read = vi.fn(async () => CHATS);
		expect(await searchPastChats("dog", { userId: undefined }, 0, read)).toBeNull();
		expect(read).not.toHaveBeenCalled();
	});

	it("reads only the asking owner's chats, leaving out the current one, and numbers after earlier sources", async () => {
		const read = vi.fn(async () => CHATS);
		const r = await searchPastChats("beagle", { userId: "u-1", currentConversationId: "c-now" }, 3, read);
		expect(read).toHaveBeenCalledWith("u-1", "c-now");
		expect(r?.sources[0]).toMatchObject({ n: 4, engine: "PastChat", title: "My new dog" });
		expect(r?.sources[0].url).toMatch(/\/conversation\/c-dog$/);
		expect(r?.sources[0].snippet).toMatch(/^You wrote: /);
		expect(r?.evidence).toContain("[4] My new dog (your past chats)");
	});

	it("returns null when nothing matched, so the tool says it found nothing", async () => {
		expect(await searchPastChats("zeppelin", { userId: "u-1" }, 0, async () => CHATS)).toBeNull();
	});
});
