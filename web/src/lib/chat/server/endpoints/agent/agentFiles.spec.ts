import { describe, it, expect, vi, afterEach } from "vitest";
import { ObjectId } from "bson";
import type { MessageFile } from "$lib/chat/types/Message";
import { keepAgentFiles } from "./agentFiles";

vi.mock("$lib/chat/server/agentArtifactDownload", () => ({ agentArtifactDownloadEnabled: () => true }));

const { endpointAgent } = await import("./endpointAgent");

/** A save that stores nothing and hands back the reference storeChatAttachments would. */
const fakeSave = (seen: File[][] = []) =>
	vi.fn(async (files: File[]): Promise<MessageFile[]> => {
		seen.push(files);
		return files.map((f, i) => ({ type: "hash", value: `${i}`.padStart(64, "a"), mime: f.type, name: f.name }));
	});

describe("keepAgentFiles (CUR-4398)", () => {
	it("saves a whole inlined file from its text and fetches a truncated one from the workdir", async () => {
		const read = vi.fn(async () => new TextEncoder().encode("full,csv\n1,2\n"));
		const seen: File[][] = [];
		const saved = await keepAgentFiles(
			[
				{ name: "notes.txt", bytes: 6, text: "hello\n", truncated: false },
				{ name: "out/data.csv", bytes: 13, text: "full,", truncated: true },
			],
			{ read, save: fakeSave(seen) }
		);
		expect(read).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith("out/data.csv");
		expect(await seen[0][0].text()).toBe("hello\n");
		expect(await seen[0][1].text()).toBe("full,csv\n1,2\n");
		// The stored name is the last segment (what My files shows); the path rides on the reference.
		expect(saved.map((s) => [s.agentPath, s.ref.name, s.ref.agentPath, s.ref.mime])).toEqual([
			["notes.txt", "notes.txt", "notes.txt", "text/plain"],
			["out/data.csv", "data.csv", "out/data.csv", "text/csv"],
		]);
	});

	it("leaves a file over the size cap to the live link, without fetching it", async () => {
		const read = vi.fn(async () => new Uint8Array(1));
		const saved = await keepAgentFiles(
			[{ name: "big.bin", bytes: 10 * 1024 * 1024 + 1 /* one over the cap */, text: null, truncated: true }],
			{ read, save: fakeSave() }
		);
		expect(read).not.toHaveBeenCalled();
		expect(saved).toEqual([]);
	});

	it("skips a file the workdir no longer has and still saves the rest", async () => {
		const saved = await keepAgentFiles(
			[
				{ name: "gone.png", bytes: 10, text: null, truncated: true },
				{ name: "kept.md", bytes: 3, text: "# a", truncated: false },
			],
			{ read: async () => undefined, save: fakeSave() }
		);
		expect(saved.map((s) => s.agentPath)).toEqual(["kept.md"]);
	});

	it("pairs no path with a reference when the save answers with a different count", async () => {
		const saved = await keepAgentFiles(
			[
				{ name: "a.txt", bytes: 1, text: "a", truncated: false },
				{ name: "b.txt", bytes: 1, text: "b", truncated: false },
			],
			{ read: async () => undefined, save: async (files) => (await fakeSave()(files)).slice(1) }
		);
		expect(saved).toEqual([]);
	});
});

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const f of frames) controller.enqueue(enc.encode(f));
			controller.close();
		},
	});
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

afterEach(() => vi.unstubAllGlobals());

async function agentTurn(artifacts: unknown[], params: Record<string, unknown>) {
	const fetchMock = vi.fn(async (url: string | URL) => {
		const u = String(url);
		if (u.endsWith("/run"))
			return { ok: true, status: 200, json: async () => ({ id: "t1" }), text: async () => "" } as Response;
		if (u.includes("/run/t1/events"))
			return {
				ok: true,
				status: 200,
				body: sseStream([frame("done", { state: "COMPLETED", result: "Wrote them.", artifacts })]),
			} as unknown as Response;
		if (u.includes("/artifacts/")) return new Response("from the workdir");
		throw new Error(`unexpected url ${u}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	const factory = await endpointAgent({ type: "agent", baseURL: "http://agent.test", apiKey: "", model: {} });
	const stream = await factory({ messages: [{ from: "user", content: "go" }], ...params } as Parameters<
		typeof factory
	>[0]);
	const chunks: { generated_text: string | null; agentFile?: { name: string; agentPath: string } }[] = [];
	for await (const c of stream) chunks.push(c as (typeof chunks)[number]);
	return { chunks, fetchMock };
}

describe("an agent turn's files are saved with the conversation (CUR-4398)", () => {
	const conversationId = new ObjectId();

	it("saves both files of a two-file turn and yields one file reference each", async () => {
		const seen: File[][] = [];
		const { chunks, fetchMock } = await agentTurn(
			[
				{ name: "a.txt", bytes: 2, text: "a\n", truncated: false },
				{ name: "sub/b.py", bytes: 9000, text: "print(", truncated: true },
			],
			{ conversationId, saveAgentFiles: fakeSave(seen) }
		);
		expect(seen).toHaveLength(1);
		expect(await seen[0][1].text()).toBe("from the workdir");
		expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
			`http://agent.test/sessions/${conversationId.toString()}/artifacts/sub/b.py`
		);
		expect(chunks.filter((c) => c.agentFile).map((c) => c.agentFile?.agentPath)).toEqual(["a.txt", "sub/b.py"]);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expect(answer).toContain("Saved with this conversation, so you can download them any time.");
		// Each link names its own saved copy, so a later turn's copy of the same path never answers for it.
		expect(answer).toContain(`/sub/b.py?saved=${"1".padStart(64, "a")}`);
		expect(answer).not.toContain("about four hours");
	});

	it("keeps the four-hour line when the save fails, and the turn still answers", async () => {
		const { chunks } = await agentTurn([{ name: "a.txt", bytes: 2, text: "a\n", truncated: false }], {
			conversationId,
			saveAgentFiles: async () => {
				throw new Error("quota");
			},
		});
		expect(chunks.some((c) => c.agentFile)).toBe(false);
		const answer = chunks.find((c) => c.generated_text)?.generated_text ?? "";
		expect(answer).toContain("Wrote them.");
		expect(answer).toContain("Available to download for about four hours");
	});

	it("saves nothing on a turn with no conversation, where there is no workdir to read", async () => {
		const save = fakeSave();
		const { chunks } = await agentTurn([{ name: "a.txt", bytes: 2, text: "a\n", truncated: false }], {
			saveAgentFiles: save,
		});
		expect(save).not.toHaveBeenCalled();
		expect(chunks.some((c) => c.agentFile)).toBe(false);
	});
});
