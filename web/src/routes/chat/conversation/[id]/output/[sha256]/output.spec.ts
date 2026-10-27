import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";

// Downloading a chat's attachment reads the bucket copy. When Hugging Face throttles the storage token
// past the read's one retry, the route says storage is busy instead of answering 500 (CUR-3680).
const download = vi.fn();
vi.mock("$lib/chat/server/files/downloadFile", async (orig) => ({
	...(await orig<typeof import("$lib/chat/server/files/downloadFile")>()),
	downloadFile: (...args: unknown[]) => download(...args),
}));
vi.mock("$lib/chat/server/textOnly", () => ({ multimodalEnabled: () => true }));
const findOne = vi.fn();
vi.mock("$lib/chat/server/database", () => ({
	collections: { conversations: { findOne: (...args: unknown[]) => findOne(...args) } },
}));

import { HubApiError } from "@huggingface/hub";
import { AttachmentReadError } from "$lib/chat/server/files/downloadFile";
import { STORAGE_BUSY_MESSAGE } from "$lib/chat/constants/custodialUpload";
import { GET } from "./+server";

const sha = "a".repeat(64);
const conv = { _id: new ObjectId(), userId: new ObjectId(), messages: [{ files: [{ value: sha, name: "notes.txt", mime: "text/plain" }] }] };

async function get(): Promise<Response> {
	try {
		return await GET({
			locals: { user: { _id: conv.userId }, sessionId: "s1" },
			params: { id: conv._id.toString(), sha256: sha },
			request: new Request("http://localhost/x"),
		} as never);
	} catch (e) {
		const status = (e as { status?: number }).status;
		if (typeof status === "number") return new Response(JSON.stringify((e as { body?: unknown }).body), { status });
		throw e;
	}
}

describe("GET /chat/conversation/[id]/output/[sha256] when the bucket refuses", () => {
	beforeEach(() => {
		download.mockReset();
		findOne.mockReset().mockResolvedValue(conv);
	});

	it("answers a busy 503 with Retry-After (not a 500) when Hugging Face throttled the read", async () => {
		download.mockRejectedValue(
			new AttachmentReadError("The storage bucket could not be read", {
				cause: new HubApiError("https://huggingface.co/api/buckets/x/resolve/f", 429),
			})
		);
		const res = await get();
		expect(res.status).toBe(503);
		expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(((await res.json()) as { message: string }).message).toBe(STORAGE_BUSY_MESSAGE);
	});

	it("answers 503 that asks for a retry (not a 500) when the bucket failed twice another way", async () => {
		download.mockRejectedValue(
			new AttachmentReadError("The storage bucket could not be read", {
				cause: new HubApiError("https://huggingface.co/api/buckets/x/resolve/f", 502),
			})
		);
		const res = await get();
		expect(res.status).toBe(503);
		expect(JSON.stringify(await res.json())).toMatch(/try again/i);
	});

	it("still serves the file when the read succeeds", async () => {
		download.mockResolvedValue({ type: "base64", name: "n", value: Buffer.from("hi").toString("base64"), mime: "text/plain" });
		const res = await get();
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hi");
	});
});
