import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";

// An agent turn saves its files with the conversation, and the reply's download link reads
// that copy before agent-service's workdir, which a deploy or the idle reaper erases. (CUR-4398)
const download = vi.fn();
vi.mock("$lib/chat/server/files/downloadFile", async (orig) => ({
	...(await orig<typeof import("$lib/chat/server/files/downloadFile")>()),
	downloadFile: (...args: unknown[]) => download(...args),
}));
vi.mock("$lib/chat/server/agentArtifactDownload", () => ({ agentArtifactDownloadEnabled: () => true }));
vi.mock("$lib/chat/server/agentMode", () => ({
	agentServiceUrl: () => "http://agent.test",
	agentServiceToken: () => "",
}));
const findOne = vi.fn();
vi.mock("$lib/chat/server/database", () => ({
	collections: { conversations: { findOne: (...args: unknown[]) => findOne(...args) } },
}));
const conv = {
	_id: new ObjectId(),
	userId: new ObjectId(),
	messages: [
		{ from: "assistant", files: [{ type: "hash", value: "a".repeat(64), name: "b.py", mime: "text/x-python", agentPath: "sub/b.py" }] },
	],
};
vi.mock("$lib/chat/server/loadOwnedConversation", () => ({ loadOwnedConversation: async () => conv._id }));

import { GET } from "./+server";

const SHA = "a".repeat(64);

async function get(filename: string, saved?: string): Promise<Response> {
	const url = new URL(`http://test/chat/conversation/x/agent-artifact/${filename}`);
	if (saved) url.searchParams.set("saved", saved);
	try {
		return await GET({
			locals: { user: { _id: conv.userId }, sessionId: "s1" },
			params: { id: conv._id.toString(), filename },
			url,
		} as never);
	} catch (e) {
		const status = (e as { status?: number }).status;
		if (typeof status === "number") return new Response(null, { status });
		throw e;
	}
}

describe("GET /chat/conversation/[id]/agent-artifact/[...filename]", () => {
	const fetchMock = vi.fn(async () => new Response("from the workdir"));
	beforeEach(() => {
		download.mockReset();
		findOne.mockReset().mockResolvedValue(conv);
		fetchMock.mockClear();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("serves the copy the turn saved without asking agent-service", async () => {
		download.mockResolvedValue({ type: "base64", name: "b.py", value: Buffer.from("print(1)\n").toString("base64"), mime: "text/x-python" });
		const res = await get("sub/b.py", SHA);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("print(1)\n");
		expect(res.headers.get("content-disposition")).toContain('filename="b.py"');
		expect(download.mock.calls[0]?.[0]).toBe(SHA);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to the live workdir for a file no turn saved", async () => {
		const res = await get("other.txt");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("from the workdir");
		expect(download).not.toHaveBeenCalled();
	});

	it("sends a link that names no saved copy to the workdir, never to an earlier turn's copy of that path", async () => {
		const res = await get("sub/b.py");
		expect(await res.text()).toBe("from the workdir");
		expect(download).not.toHaveBeenCalled();
	});

	it("sends a link naming a copy the conversation does not hold to the workdir", async () => {
		const res = await get("sub/b.py", "b".repeat(64));
		expect(await res.text()).toBe("from the workdir");
		expect(download).not.toHaveBeenCalled();
	});

	it("falls back to the live workdir when the saved copy cannot be read", async () => {
		download.mockRejectedValue(new Error("bucket down"));
		const res = await get("sub/b.py", SHA);
		expect(await res.text()).toBe("from the workdir");
	});
});
