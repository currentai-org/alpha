import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/db/wipeScope", () => ({ previewWipe: vi.fn() }));

import { GET } from "./+server";
import { previewWipe } from "$lib/chat/server/db/wipeScope";

const preview = vi.mocked(previewWipe);

function get(locals: Record<string, unknown>, account = false) {
	return GET({
		locals,
		url: new URL(`http://localhost/chat/api/v2/conversations/wipe-preview${account ? "?account=delete" : ""}`),
	} as never);
}

describe("GET /chat/api/v2/conversations/wipe-preview", () => {
	beforeEach(() => {
		preview.mockReset();
		preview.mockResolvedValue({ conversations: 1 } as never);
	});

	it("counts only the caller's own session and user ids, never a client-supplied one", async () => {
		await get({ user: { _id: "u1" }, sessionId: "s1" });
		expect(preview).toHaveBeenCalledWith({ sessionId: "s1", userId: "u1", deleteAccount: false });
	});

	it("asks for the account to be counted only when ?account=delete is sent", async () => {
		await get({ sessionId: "s1" }, true);
		expect(preview).toHaveBeenCalledWith({ sessionId: "s1", userId: undefined, deleteAccount: true });
	});

	it("answers no-store JSON so a stale count is never replayed", async () => {
		const res = await get({ sessionId: "s1" });
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toEqual({ conversations: 1 });
	});

	it("fails with a 503 rather than a made-up zero when the count fails", async () => {
		preview.mockRejectedValue(new Error("db down"));
		await expect(get({ sessionId: "s1" })).rejects.toMatchObject({ status: 503 });
	});
});
