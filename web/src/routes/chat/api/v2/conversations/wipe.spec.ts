import { beforeEach, describe, expect, it, vi } from "vitest";

// Forget everything and Delete account wipe the person's bucket files first. When Hugging Face throttles
// the storage token, the answer is busy with the window's Retry-After, not "try again" now (CUR-3680).
vi.mock("$lib/chat/server/db/wipeUserData", () => ({ wipeUserData: vi.fn() }));

import { HubApiError } from "@huggingface/hub";
import { CustodialWipeError } from "$lib/chat/server/storage/custodialStorage";
import { WIPE_BUSY_MESSAGE } from "$lib/chat/constants/custodialUpload";
import { DELETE } from "./+server";
import { wipeUserData } from "$lib/chat/server/db/wipeUserData";

const wipe = vi.mocked(wipeUserData);

async function del(account = false): Promise<Response> {
	try {
		return await DELETE({
			locals: { user: { _id: "u1" }, sessionId: "s1" },
			url: new URL(`http://localhost/chat/api/v2/conversations${account ? "?account=delete" : ""}`),
			request: new Request("http://localhost/chat/api/v2/conversations", { method: "DELETE" }),
		} as never);
	} catch (e) {
		const status = (e as { status?: number }).status;
		if (typeof status === "number") return new Response(JSON.stringify((e as { body?: unknown }).body), { status });
		throw e;
	}
}

describe("DELETE /chat/api/v2/conversations when the bucket refuses", () => {
	beforeEach(() => {
		wipe.mockReset();
	});

	it("answers a busy 503 with Retry-After (not a 502 'try again') when Hugging Face throttled the file wipe", async () => {
		wipe.mockRejectedValue(new CustodialWipeError(0, 0, new HubApiError("https://huggingface.co/api/buckets/x/tree", 429)));
		for (const account of [false, true]) {
			const res = await del(account);
			expect(res.status).toBe(503);
			expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
			expect(((await res.json()) as { message: string }).message).toBe(WIPE_BUSY_MESSAGE);
		}
	});

	it("keeps the 502 nothing-was-cleared answer for a wipe that failed another way", async () => {
		wipe.mockRejectedValue(new CustodialWipeError(2, 1, new HubApiError("https://huggingface.co/api/buckets/x/tree", 500)));
		const res = await del();
		expect(res.status).toBe(502);
		expect(await res.text()).toMatch(/nothing was cleared/);
	});
});
