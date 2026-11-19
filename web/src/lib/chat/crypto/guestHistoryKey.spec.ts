import { beforeEach, describe, expect, it, vi } from "vitest";

// A guest's key opens on every page, so Search chats and the chat list can read sealed chats from the
// landing page; it is still made only on a conversation page.
const H = vi.hoisted(() => ({ ensure: vi.fn(async () => {}), read: vi.fn(async () => ({ kind: "none" })) }));
vi.mock("./historyKeyClient", () => ({
	ensureGuestHistoryKey: H.ensure,
	readHistoryKeyState: H.read,
	historyKeyOwner: (id: string | null) => (id ? `user:${id}` : "guest"),
}));

import { guestHistoryKeyState } from "./guestHistoryKey";
import type { HistoryKeyApi } from "./historyKeyClient";

const api = {} as HistoryKeyApi;

beforeEach(() => {
	H.ensure.mockClear();
	H.read.mockClear();
});

describe("guestHistoryKeyState", () => {
	it("opens an existing guest key off a conversation page, without making one", async () => {
		H.read.mockResolvedValueOnce({ kind: "unlocked" } as never);
		expect(await guestHistoryKeyState(api, "This browser", false)).toEqual({ kind: "unlocked" });
		expect(H.read).toHaveBeenCalledWith(api, "guest");
		expect(H.ensure).not.toHaveBeenCalled();
	});

	it("makes the key first on a conversation page, then opens it", async () => {
		await guestHistoryKeyState(api, "This browser", true);
		expect(H.ensure).toHaveBeenCalledWith(api, "This browser");
		expect(H.read).toHaveBeenCalledWith(api, "guest");
	});
});
