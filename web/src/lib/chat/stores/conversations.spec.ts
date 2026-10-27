import { beforeEach, describe, expect, it, vi } from "vitest";

// refresh() fetches through the API client; each test sets what the server list returns.
let serverList: Array<{ _id: string; title: string; updatedAt: string; model?: string }> = [];
vi.mock("$app/environment", () => ({ browser: true }));
vi.mock("$lib/chat/APIClient", () => ({
	useAPIClient: () => ({
		conversations: {
			get: async () => ({ conversations: serverList, hasMore: false }),
		},
	}),
	handleResponse: (r: unknown) => r,
}));

const { ConversationsStore } = await import("./conversations.svelte");

const ID = "6ab54542987b7a161205a83f";
const at = "2026-09-24T15:44:19.821Z";

describe("conversations store: title source across a server resync (CUR-1971)", () => {
	let store: InstanceType<typeof ConversationsStore>;

	beforeEach(() => {
		store = new ConversationsStore();
		store.init([{ id: ID, title: "New Chat", updatedAt: new Date(at) }]);
	});

	it("keeps the title source through the post-turn refresh when the server returns the same title", async () => {
		store.update(ID, { title: "Japan capital", titleSource: "model" });
		serverList = [{ _id: ID, title: "Japan capital", updatedAt: at }];

		await store.refresh();

		expect(store.list[0].title).toBe("Japan capital");
		expect(store.list[0].titleSource).toBe("model");
	});

	it("keeps the title source through a layout init() that replaces the list", () => {
		store.update(ID, { title: "Japan capital", titleSource: "model" });

		store.init([{ id: ID, title: "Japan capital", updatedAt: new Date(at) }]);

		expect(store.list[0].titleSource).toBe("model");
	});

	it("drops the title source once the server shows a different title, since it no longer describes it", async () => {
		store.update(ID, { title: "Japan capital", titleSource: "model" });
		serverList = [{ _id: ID, title: "Renamed by hand", updatedAt: at }];

		await store.refresh();

		expect(store.list[0].titleSource).toBeUndefined();
	});

	it("applies a source that arrived before its entry existed, once a resync brings the entry in", async () => {
		store.init([]);
		store.update(ID, { title: "Japan capital", titleSource: "model" });
		serverList = [{ _id: ID, title: "Japan capital", updatedAt: at }];

		await store.refresh();

		expect(store.list[0].titleSource).toBe("model");
	});
});

// The side rail can end up rendering its own copy of the list (NavMenu reassigns its
// prop when the infinite scroll loads a page), and a copy only follows a new array, never an
// element written in place. So a title written in place reaches the header and leaves the rail
// on "New Chat" until the post-turn refresh swaps the whole list.
describe("conversations store: a title update reaches every reader of the list (CUR-2379)", () => {
	it("hands readers a new array on update, so a component holding the old one is told to re-read", () => {
		const store = new ConversationsStore();
		store.init([{ id: ID, title: "New Chat", updatedAt: new Date(at) }]);
		const before = store.list;

		store.update(ID, { title: "Japan capital", titleSource: "model" });

		expect(store.list).not.toBe(before);
		expect(store.list[0].title).toBe("Japan capital");
	});
});

// The shell's first-load list can resolve after the landing page prepended the
// conversation it just created. Nothing reloads the layout on the move to that
// conversation, so a list that replaces the prepend leaves the new chat out of the rail for its
// whole first turn.
describe("conversations store: a just-created conversation survives a late first-load list (CUR-2391)", () => {
	const NEW = "6abcd2e07da1da63c27da414";
	const OLD = "6ab54542987b7a161205a83f";

	it("keeps the prepended conversation on top when the late list does not have it yet", () => {
		const store = new ConversationsStore();
		store.prepend({ id: NEW, title: "New Chat", updatedAt: new Date(at) });
		store.update(NEW, { title: "Japan capital", titleSource: "model" });

		store.init([{ id: OLD, title: "Older chat", updatedAt: new Date(at) }], { keepPrepended: true });

		expect(store.list.map((c) => c.id)).toEqual([NEW, OLD]);
		expect(store.list[0].title).toBe("Japan capital");
	});

	it("takes the server's copy once a list includes the conversation, and does not add it twice", () => {
		const store = new ConversationsStore();
		store.prepend({ id: NEW, title: "New Chat", updatedAt: new Date(at) });

		store.init([{ id: NEW, title: "From server", updatedAt: new Date(at) }], { keepPrepended: true });
		store.init([{ id: OLD, title: "Older chat", updatedAt: new Date(at) }], { keepPrepended: true });

		expect(store.list.map((c) => c.id)).toEqual([OLD]);
	});

	it("drops it on a plain replace, so a wipe clears the rail", () => {
		const store = new ConversationsStore();
		store.prepend({ id: NEW, title: "New Chat", updatedAt: new Date(at) });

		store.init([]);

		expect(store.list).toEqual([]);
	});

	it("drops it when the conversation is deleted before any list arrives", () => {
		const store = new ConversationsStore();
		store.prepend({ id: NEW, title: "New Chat", updatedAt: new Date(at) });

		store.remove(NEW);
		store.init([], { keepPrepended: true });

		expect(store.list).toEqual([]);
	});

	it("lets a refresh, which is always fetched after the prepend, decide the list", async () => {
		const store = new ConversationsStore();
		store.prepend({ id: NEW, title: "New Chat", updatedAt: new Date(at) });
		serverList = [{ _id: OLD, title: "Older chat", updatedAt: at }];

		await store.refresh();

		expect(store.list.map((c) => c.id)).toEqual([OLD]);
	});
});

// A client navigation that reruns only the root layout (New chat's goto, invalidated=101) hands the
// shell its chat layout's page-load list again, the same array as before. Applied a second time it
// would replace everything the post-turn refresh brought in, so each chat made since the page loaded
// would leave the rail until a reload.
describe("conversations store: the layout's list re-handed by a root-only navigation (CUR-2545)", () => {
	const NEW = "6abe6930638d6d22f9279e38";
	const OLD = "6ab54542987b7a161205a83f";

	it("ignores the page-load list handed back again after a refresh, so new chats stay in the rail", async () => {
		const store = new ConversationsStore();
		const pageLoad = [{ id: OLD, title: "Older chat", updatedAt: new Date(at) }];
		store.init(pageLoad, { keepPrepended: true });
		store.prepend({ id: NEW, title: "New Chat", updatedAt: new Date(at) });
		serverList = [
			{ _id: NEW, title: "Japan capital", updatedAt: at },
			{ _id: OLD, title: "Older chat", updatedAt: at },
		];
		await store.refresh();

		store.init(pageLoad, { keepPrepended: true });

		expect(store.list.map((c) => c.id)).toEqual([NEW, OLD]);
	});

	it("still applies a list the layout loaded afresh, even with the same contents", async () => {
		const store = new ConversationsStore();
		store.init([{ id: OLD, title: "Older chat", updatedAt: new Date(at) }], { keepPrepended: true });
		serverList = [{ _id: NEW, title: "Japan capital", updatedAt: at }];
		await store.refresh();

		store.init([{ id: OLD, title: "Older chat", updatedAt: new Date(at) }], { keepPrepended: true });

		expect(store.list.map((c) => c.id)).toEqual([OLD]);
	});
});
