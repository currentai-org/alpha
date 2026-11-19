// How past-chat search reaches a turn. Three things must all hold for a turn to search the
// person's earlier chats (an account, their own switch, the flag), and with any one missing the model is
// offered no tool and is told it sees this conversation only.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));
const flagOn = { value: false };
// Whether the account's chats are sealed, as sealedTurn.ts ownerHoldsOwnHistoryKey would read it: true only for a person-held key.
const sealedOwner = vi.hoisted(() => ({ value: false, asked: [] as string[] }));
vi.mock("$lib/chat/server/chat/sealedTurn", () => ({
	ownerHoldsOwnHistoryKey: async (owner: { userId?: { toString(): string } }) => {
		sealedOwner.asked.push(String(owner.userId));
		return sealedOwner.value;
	},
}));
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (k: string, fallback: () => boolean) => (k === "past-chat-search" ? flagOn.value : fallback()),
	ensureFlagsPolled: async () => {},
	flagsDebugState: () => ({ polledOk: true, lastRefreshAt: 0, size: 1 }),
}));

const { nativeToolKit } = await import("./nativeTools");
const { pastChatsForTurn } = await import("../pastChatSearchGate");
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
	sealedOwner.value = false;
	sealedOwner.asked = [];
});

describe("pastChatsForTurn", () => {
	it("is off unless the flag, an account and the person's own switch are all on", async () => {
		const on = async (locals: App.Locals | undefined, setting: boolean | undefined) =>
			(await pastChatsForTurn(locals, setting, "c-now")).state === "on";
		flagOn.value = true;
		expect(await on(signedIn, true)).toBe(true);
		expect(await on(signedIn, undefined)).toBe(false);
		expect(await on(signedIn, false)).toBe(false);
		expect(await on(guest, true)).toBe(false);
		expect(await on(undefined, true)).toBe(false);
		flagOn.value = false;
		expect(await on(signedIn, true)).toBe(false);
	});
});

describe("search_past_chats tool", () => {
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

describe("accountClause with past-chat search", () => {
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

describe("past-chat search for an account whose chats are sealed", () => {
	it("offers search_past_chats to an account with plaintext chats, as before", async () => {
		flagOn.value = true;
		const turn = await pastChatsForTurn(signedIn, true, "c-now");
		expect(turn).toEqual({ state: "on", owner: { userId: "u-1", currentConversationId: "c-now" } });
	});

	it("is not offered for an account whose chats are sealed: the turn gets no owner, so no tool, and says why", async () => {
		flagOn.value = true;
		sealedOwner.value = true;
		const turn = await pastChatsForTurn(signedIn, true, "c-now");
		expect(turn).toEqual({ state: "sealed" });
		expect(sealedOwner.asked).toEqual(["u-1"]);
		// native.ts hands the tool kit an owner only for state "on".
		const kit = nativeToolKit({ locals: signedIn, web: false, pastChats: turn.state === "on" ? turn.owner : undefined });
		expect(toolNames(kit)).not.toContain("search_past_chats");
	});

	it("never asks whether chats are sealed when past-chat search is off anyway", async () => {
		sealedOwner.value = true;
		expect(await pastChatsForTurn(signedIn, true, "c-now")).toEqual({ state: "off" });
		flagOn.value = true;
		expect(await pastChatsForTurn(guest, true, "c-now")).toEqual({ state: "off" });
		expect(await pastChatsForTurn(signedIn, false, "c-now")).toEqual({ state: "off" });
		expect(sealedOwner.asked).toEqual([]);
	});

	it("tells the model past-chat search is unavailable, not that it found nothing", () => {
		const clause = accountClause({ loginOffered: true, signedIn: true, pastChats: "sealed" });
		expect(clause).toContain("past-chat search is unavailable");
		expect(clause).not.toContain("search_past_chats");
		expect(clause).toContain("never claim to recall");
	});
});
