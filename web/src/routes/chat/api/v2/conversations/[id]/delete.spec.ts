import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";

// Deleting one chat lists the person's bucket folder first. When Hugging Face throttles the storage token,
// that listing throws, and the route must say storage is busy rather than answer 500 (CUR-3666).
const cascade = vi.fn();
vi.mock("$lib/chat/server/db/deleteConversations", () => ({
	deleteConversationsCascade: (...args: unknown[]) => cascade(...args),
}));
const findOne = vi.fn();
vi.mock("$lib/chat/server/database", () => ({
	collections: { conversations: { findOne: (...args: unknown[]) => findOne(...args) } },
}));

import { HubApiError } from "@huggingface/hub";
import { CustodialWipeError } from "$lib/chat/server/storage/custodialStorage";
import { CHAT_DELETE_BUSY_MESSAGE } from "$lib/chat/constants/custodialUpload";
import { DELETE } from "./+server";

const userId = new ObjectId();
const conv = { _id: new ObjectId(), userId };
const locals = { user: { _id: userId }, sessionId: "s1" };

async function del(): Promise<Response> {
	try {
		return await DELETE({
			locals,
			params: { id: conv._id.toString() },
			request: new Request("http://localhost/chat/api/v2/conversations/x", { method: "DELETE" }),
		} as never);
	} catch (e) {
		// SvelteKit's error() throws an HttpError; turn it into the status the client would see.
		const status = (e as { status?: number }).status;
		if (typeof status === "number") return new Response(JSON.stringify((e as { body?: unknown }).body), { status });
		throw e;
	}
}

describe("DELETE /chat/api/v2/conversations/[id] when the bucket refuses", () => {
	beforeEach(() => {
		cascade.mockReset();
		findOne.mockReset().mockResolvedValue(conv);
	});

	it("answers a busy 503 with Retry-After (not a 500) when Hugging Face throttled the folder wipe", async () => {
		cascade.mockRejectedValue(
			new CustodialWipeError(0, 0, new HubApiError("https://huggingface.co/api/buckets/x/tree", 429))
		);
		const res = await del();
		expect(res.status).toBe(503);
		expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(((await res.json()) as { message: string }).message).toBe(CHAT_DELETE_BUSY_MESSAGE);
	});

	it("answers 502 with a keep-and-retry line (not a 500) when the folder wipe fails for another reason", async () => {
		cascade.mockRejectedValue(
			new CustodialWipeError(2, 1, new HubApiError("https://huggingface.co/api/buckets/x/tree", 500))
		);
		const res = await del();
		expect(res.status).toBe(502);
		expect(JSON.stringify(await res.json())).toMatch(/kept/);
	});

	it("still deletes and answers 200 when the wipe succeeds", async () => {
		cascade.mockResolvedValue(1);
		const res = await del();
		expect(res.status).toBe(200);
		expect(cascade).toHaveBeenCalledWith([conv._id.toString()], userId.toString(), undefined);
	});
});
