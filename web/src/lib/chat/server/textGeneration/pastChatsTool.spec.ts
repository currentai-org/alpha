// How past-chat search reaches a turn. Three things must all hold for a turn to search the
// person's earlier chats (an account, their own switch, the flag), and with any one missing the model is
// offered no tool and is told it sees this conversation only. (CUR-4576)
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));
const flagOn = { value: false };
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (k: string, fallback: () => boolean) => (k === "past-chat-search" ? flagOn.value : fallback()),
	ensureFlagsPolled: async () => {},
	flagsDebugState: () => ({ polledOk: true, lastRefreshAt: 0, size: 1 }),
}));

const { nativeToolKit } = await import("./nativeTools");
const { pastChatSearchOn } = await import("../pastChatSearchGate");
const { accountClause } = await import("./persona");

const signedIn = { user: { _id: { toString: () => "u-1" } } } as unknown as App.Locals;
const guest = { sessionId: "s-1" } as unknown as App.Locals;
const toolNames = (kit: ReturnType<typeof nativeToolKit>) => kit.definitions.map((d) => d.function.name);
const pastHit = {
	query: "dog",
	asOf: "2026-10-25T00:00:00Z",
	evidence: "[1] My new dog (your past chats)\nYou wrote: My dog is called Quillon.",
	sources: [
		{ n: 1, title: "My new dog", url: "/chat/conversation/c-dog", snippet: "You wrote: My dog is called Quillon.", engine: "PastChat" as const },
	],
};

beforeEach(() => {
	flagOn.value = false;
});

describe("pastChatSearchOn (CUR-4576)", () => {
	it("is off unless the flag, an account and the person's own switch are all on", () => {
		flagOn.value = true;
		expect(pastChatSearchOn(signedIn, true)).toBe(true);
		expect(pastChatSearchOn(signedIn, undefined)).toBe(false);
		expect(pastChatSearchOn(signedIn, false)).toBe(false);
		expect(pastChatSearchOn(guest, true)).toBe(false);
		expect(pastChatSearchOn(undefined, true)).toBe(false);
		flagOn.value = false;
		expect(pastChatSearchOn(signedIn, true)).toBe(false);
	});
});

describe("search_past_chats tool (CUR-4576)", () => {
	it("is not offered, and never searches, when the turn has no past-chat owner", async () => {
		const pastChats = vi.fn(async () => pastHit);
		const kit = nativeToolKit({ locals: signedIn, web: false, engines: { web: vi.fn(), catalog: vi.fn(), pastChats } });
		expect(toolNames(kit)).not.toContain("search_past_chats");
		const r = await kit.run({ id: "1", name: "search_past_chats", arguments: '{"query":"dog"}' });
		expect(r.content).toMatch(/no tool named/i);
		expect(pastChats).not.toHaveBeenCalled();
	});

	it("searches the owner's chats, leaving out this one, and stamps the passages as PastChat sources", async () => {
		const pastChats = vi.fn(async () => pastHit);
		const kit = nativeToolKit({
			locals: signedIn,
			web: false,
			visitorSourceCount: 2,
			pastChats: { userId: "u-1", currentConversationId: "c-now" },
			engines: { web: vi.fn(), catalog: vi.fn(), pastChats },
		});
		expect(toolNames(kit)).toContain("search_past_chats");
		const r = await kit.run({ id: "1", name: "search_past_chats", arguments: '{"query":"dog"}' });
		expect(pastChats).toHaveBeenCalledWith("dog", { userId: "u-1", currentConversationId: "c-now" }, 2);
		expect(r.content).toContain("earlier chats");
		expect(r.content).toContain("Quillon");
		expect(r.rag?.sources.map((s) => s.engine)).toEqual(["PastChat"]);
		expect(kit.retrievalOf?.([{ id: "1", name: "search_past_chats", arguments: "{}" }])).toBe("documents");
	});

	it("tells the model it found nothing, and stamps no source, when no earlier chat matched", async () => {
		const kit = nativeToolKit({
			locals: signedIn,
			web: false,
			pastChats: { userId: "u-1", currentConversationId: "c-now" },
			engines: { web: vi.fn(), catalog: vi.fn(), pastChats: vi.fn(async () => null) },
		});
		const r = await kit.run({ id: "1", name: "search_past_chats", arguments: '{"query":"zeppelin"}' });
		expect(r.content).toMatch(/nothing/i);
		expect(r.rag).toBeUndefined();
	});
});

describe("accountClause with past-chat search (CUR-4576)", () => {
	const base = { loginOffered: true, signedIn: true };
	it("keeps the this-conversation-only rule while past-chat search is off", () => {
		expect(accountClause(base)).toContain("You see only the messages in this conversation");
		expect(accountClause(base)).not.toContain("search_past_chats");
	});
	it("names the tool, and still forbids recalling what the search did not return, once it is on", () => {
		const clause = accountClause({ ...base, pastChats: true });
		expect(clause).toContain("search_past_chats");
		expect(clause).toContain("that the search did not return");
		expect(clause).not.toContain("You see only the messages in this conversation");
	});
});
