import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { StorageLocation } from "$lib/chat/server/storage/locations/types";
import { sha256 } from "$lib/chat/utils/sha256";

const { storeChatAttachment, uploadFile, configured, enabled, guestsEnabled } = vi.hoisted(() => ({
	storeChatAttachment: vi.fn(),
	uploadFile: vi.fn(),
	configured: { value: true },
	enabled: { value: true },
	guestsEnabled: { value: true },
}));

vi.mock("$lib/chat/server/storage/custodialStorage", async (orig) => {
	const actual = await orig<typeof import("$lib/chat/server/storage/custodialStorage")>();
	return {
		PASTES_DIRNAME: actual.PASTES_DIRNAME,
		StorageQuotaExceededError: actual.StorageQuotaExceededError,
		hubRateLimitedError: actual.hubRateLimitedError,
		hubRateLimitedUrl: actual.hubRateLimitedUrl,
		storeChatAttachment,
		custodialStorageConfigured: () => configured.value,
	};
});
vi.mock("$lib/chat/server/files/uploadFile", () => ({ uploadFile }));
vi.mock("$lib/chat/server/storage/custodialStorageGate", () => ({
	custodialStorageViewEnabledForUser: async () => enabled.value,
	custodialStorageForGuestsEnabled: () => guestsEnabled.value,
}));
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { attachmentPath, storeChatAttachments } from "./attachmentsToCustodial";

/** attachmentsToCustodial.ts's BUCKET_WRITE_TIMEOUT_MS. */
const BUCKET_WRITE_TIMEOUT_MS = 8_000;
import { hubRateLimitedError, StorageQuotaExceededError } from "$lib/chat/server/storage/custodialStorage";

const signedIn = { _id: "c1", userId: "u1" } as unknown as Conversation;
const guest = { _id: "c1", sessionId: "s1" } as unknown as Conversation;
const attachment = (name: string, text = "hello", type = "text/plain") => ({
	file: new File([text], name, { type }),
	paste: false,
});

beforeEach(() => {
	storeChatAttachment.mockReset().mockResolvedValue(undefined);
	uploadFile.mockReset().mockImplementation(async (file: File) => ({ type: "hash", value: "table", mime: file.type, name: file.name }));
	configured.value = true;
	enabled.value = true;
	guestsEnabled.value = true;
});

describe("storeChatAttachments with custodial-storage-view on: the bucket is the first store (CUR-2183)", () => {
	it("stores each attachment once under conversations/<conversation>/<sha>/<name> and never writes the files table", async () => {
		const refs = await storeChatAttachments(signedIn, [attachment("notes.txt"), attachment("plan.csv", "a,b", "text/csv")]);
		const [hello, ab] = [await sha256("hello"), await sha256("a,b")];
		expect(storeChatAttachment.mock.calls.map((c) => [c[0], c[1]])).toEqual([
			[{ userId: "u1" }, `conversations/c1/${hello}/notes.txt`],
			[{ userId: "u1" }, `conversations/c1/${ab}/plan.csv`],
		]);
		expect(uploadFile).not.toHaveBeenCalled();
		// The reference a later turn carries names the same sha and name, so it reads the same file.
		expect(refs).toEqual([
			{ type: "hash", value: hello, mime: "text/plain", name: "notes.txt" },
			{ type: "hash", value: ab, mime: "text/csv", name: "plan.csv" },
		]);
	});

	it("keeps a long paste in the conversation's pastes folder, out of My files", async () => {
		await storeChatAttachments(signedIn, [{ file: new File(["pasted"], "Pasted Content"), paste: true }]);
		expect(storeChatAttachment.mock.calls[0][1]).toBe(`conversations/c1/pastes/${await sha256("pasted")}/Pasted Content`);
	});

	it("stores a guest's attachment under the guest's session, never as an account", async () => {
		await storeChatAttachments(guest, [attachment("notes.txt")]);
		expect(storeChatAttachment.mock.calls[0][0]).toEqual({ guestSessionId: "s1" });
	});

	it("cleans up a name the bucket can't take and keeps the file, never refusing it for its name", async () => {
		const refs = await storeChatAttachments(signedIn, [attachment(".."), attachment(`${"x".repeat(300)}.pdf`)]);
		expect(refs.map((r) => r.name)).toEqual(["attachment", `${"x".repeat(251)}.pdf`]);
		expect(storeChatAttachment).toHaveBeenCalledTimes(2);
	});

	it("keeps `#` and `?` out of a stored name, since the Hub client reads the path back unencoded", async () => {
		const refs = await storeChatAttachments(signedIn, [attachment("q#1?.txt")]);
		expect(refs[0].name).toBe("q_1_.txt");
		expect(storeChatAttachment.mock.calls[0][1]).toMatch(/\/q_1_\.txt$/);
	});
});

describe("storeChatAttachments never stalls a turn for the bucket: a failed write goes to the files table (CUR-2183)", () => {
	it.each([
		["Hugging Face throttles the token", () => hubRateLimitedError("https://huggingface.co/api/buckets")],
		["the Hub answers any other error", () => new Error("bucket down")],
	])("sends the file to the table when %s, and every file after it", async (_why, err) => {
		storeChatAttachment.mockRejectedValueOnce(err());
		const refs = await storeChatAttachments(signedIn, [attachment("a.txt"), attachment("b.txt", "b")]);
		expect(storeChatAttachment).toHaveBeenCalledTimes(1);
		expect(uploadFile.mock.calls.map((c) => (c[0] as File).name)).toEqual(["a.txt", "b.txt"]);
		expect(refs.map((r) => r.value)).toEqual(["table", "table"]);
	});

	it("keeps the bucket's references for the files written before a failure", async () => {
		storeChatAttachment.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("bucket down"));
		const refs = await storeChatAttachments(signedIn, [attachment("a.txt"), attachment("b.txt", "b")]);
		expect(refs.map((r) => r.value)).toEqual([await sha256("hello"), "table"]);
	});

	it(`gives up on a write after ${BUCKET_WRITE_TIMEOUT_MS} ms and sends the file to the table`, async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let signal: AbortSignal | undefined;
			storeChatAttachment.mockImplementationOnce((_o, _p, _c, opts: { signal?: AbortSignal }) => {
				signal = opts.signal;
				return new Promise(() => {});
			});
			const pending = storeChatAttachments(signedIn, [attachment("a.txt"), attachment("b.txt", "b")]);
			// The sha is hashed off the event loop, so the deadline is armed only once the write has started.
			while (storeChatAttachment.mock.calls.length === 0) await new Promise((r) => setImmediate(r));
			await vi.advanceTimersByTimeAsync(BUCKET_WRITE_TIMEOUT_MS - 1);
			expect(uploadFile).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			const refs = await pending;
			expect(refs.map((r) => r.value)).toEqual(["table", "table"]);
			// The abandoned write is aborted, so it cannot land a second, unreferenced copy later.
			expect(signal?.aborted).toBe(true);
			// One stalled bucket costs the turn one deadline: the second file never waits on it.
			expect(storeChatAttachment).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back under the storage_hub_rate_limited fault without touching the bucket", async () => {
		const refs = await storeChatAttachments(signedIn, [attachment("a.txt")], { fault: "storage_hub_rate_limited" });
		expect(refs[0].value).toBe("table");
		expect(storeChatAttachment).not.toHaveBeenCalled();
		expect(uploadFile).toHaveBeenCalledTimes(1);
	});

	it("still sends a guest's file to the table when the guest's quota is full, until guests get an attach-time check", async () => {
		storeChatAttachment.mockRejectedValueOnce(new StorageQuotaExceededError(1, 1));
		const refs = await storeChatAttachments(guest, [attachment("a.txt")]);
		expect(refs[0].value).toBe("table");
	});
});

describe("a signed-in person's full My files refuses the attachment and never writes the files table (CUR-3235)", () => {
	it("throws the quota error, so the turn is refused, and leaves the files table alone", async () => {
		storeChatAttachment.mockRejectedValueOnce(new StorageQuotaExceededError(1, 1));
		await expect(storeChatAttachments(signedIn, [attachment("a.txt"), attachment("b.txt", "b")])).rejects.toBeInstanceOf(
			StorageQuotaExceededError
		);
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("refuses the same way under the storage_quota_full fault, so a preview spec can drive it", async () => {
		await expect(storeChatAttachments(signedIn, [attachment("a.txt")], { fault: "storage_quota_full" })).rejects.toBeInstanceOf(
			StorageQuotaExceededError
		);
		expect(storeChatAttachment).not.toHaveBeenCalled();
		expect(uploadFile).not.toHaveBeenCalled();
	});
});

describe("storeChatAttachments with the bucket not selected: the files table, as before (CUR-2183)", () => {
	it.each([
		["the flag is off for the account", () => (enabled.value = false), signedIn],
		["the deployment has no bucket", () => (configured.value = false), signedIn],
		["guests are not selected", () => (guestsEnabled.value = false), guest],
	])("writes the table and never the bucket when %s", async (_why, setUp, conv) => {
		setUp();
		const refs = await storeChatAttachments(conv as Conversation, [attachment("notes.txt")], { fault: "storage_quota_full" });
		expect(uploadFile).toHaveBeenCalledTimes(1);
		expect(storeChatAttachment).not.toHaveBeenCalled();
		expect(refs[0].value).toBe("table");
	});
});

describe("attachmentPath", () => {
	it("refuses a sha that is not 64 hex characters rather than writing it into a path", () => {
		expect(attachmentPath("c1", "../../x", "notes.txt")).toBeUndefined();
	});

	it("keeps only the last path segment of a name, so a crafted name cannot leave the conversation folder", () => {
		expect(attachmentPath("c1", "a".repeat(64), "../../users/other/evil.txt")).toBe(`conversations/c1/${"a".repeat(64)}/evil.txt`);
		expect(attachmentPath("c1", "a".repeat(64), "..\\..\\evil.txt")).toBe(`conversations/c1/${"a".repeat(64)}/evil.txt`);
	});
});

describe("storeChatAttachments with a linked default location (CUR-2930)", () => {
	const linkedLocation = (write: (folder: string, name: string) => Promise<string>) =>
		({ id: "loc1", kind: "hf-bucket", label: "me/alpha-files", write }) as unknown as StorageLocation;

	it("writes each attachment to the linked location under conversations/<conversation>/<sha> and records where on the reference", async () => {
		const write = vi.fn(async (folder: string, name: string) => `alpha/${folder}/${name}`);
		const refs = await storeChatAttachments(signedIn, [attachment("photo.png", "png", "image/png")], {
			location: linkedLocation(write),
		});
		const sha = await sha256("png");
		expect(write.mock.calls.map((c) => [c[0], c[1]])).toEqual([[`conversations/c1/${sha}`, "photo.png"]]);
		expect(storeChatAttachment).not.toHaveBeenCalled();
		expect(refs).toEqual([
			{
				type: "hash",
				value: sha,
				mime: "image/png",
				name: "photo.png",
				location: { id: "loc1", path: `alpha/conversations/c1/${sha}/photo.png` },
			},
		]);
	});

	it("keeps a long paste in Alpha storage even with a linked default, since it is message text", async () => {
		const write = vi.fn();
		await storeChatAttachments(signedIn, [{ file: new File(["pasted"], "Pasted Content"), paste: true }], {
			location: linkedLocation(write),
		});
		expect(write).not.toHaveBeenCalled();
		expect(storeChatAttachment).toHaveBeenCalledTimes(1);
	});

	it("sends the file to Alpha storage, never refusing the turn, when the linked write fails, and stops trying the link for the rest of the turn", async () => {
		const write = vi.fn(async () => {
			throw new Error("refused");
		});
		const refs = await storeChatAttachments(signedIn, [attachment("a.txt", "a"), attachment("b.txt", "b")], {
			location: linkedLocation(write),
		});
		expect(write).toHaveBeenCalledTimes(1);
		expect(storeChatAttachment).toHaveBeenCalledTimes(2);
		expect(refs.every((r) => r.location === undefined)).toBe(true);
	});

	it("never writes a guest's attachment to a linked location", async () => {
		const write = vi.fn();
		await storeChatAttachments(guest, [attachment("notes.txt")], { location: linkedLocation(write) });
		expect(write).not.toHaveBeenCalled();
	});
});
