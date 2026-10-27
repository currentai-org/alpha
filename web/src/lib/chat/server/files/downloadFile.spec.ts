import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "bson";
import { sha256 } from "$lib/chat/utils/sha256";
import { HubApiError } from "@huggingface/hub";

const { getFileByFilename, readCustodialAttachment, readGuestAttachment, configured, warn } = vi.hoisted(() => ({
	getFileByFilename: vi.fn(),
	readCustodialAttachment: vi.fn(),
	readGuestAttachment: vi.fn(),
	configured: { value: true },
	warn: vi.fn(),
}));

vi.mock("$lib/chat/server/db/files", () => ({ getFileByFilename }));
vi.mock("$lib/chat/server/storage/custodialStorage", () => ({
	readCustodialAttachment,
	readGuestAttachment,
	custodialStorageConfigured: () => configured.value,
	hubRateLimitedError: (url: string) => new HubApiError(url, 429),
	// The same predicate the store exports; restated because the store module needs a configured Hub to load.
	transientHubError: (e: unknown) =>
		e instanceof HubApiError ? e.statusCode === 429 || e.statusCode >= 500 : e instanceof TypeError,
	PASTES_DIRNAME: "pastes",
}));
vi.mock("$lib/chat/server/storage/custodialStorageGate", () => ({
	custodialStorageViewEnabledForUser: async () => true,
}));
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: vi.fn(), warn } }));

import { AttachmentReadError, downloadFile } from "./downloadFile";

const conv = new ObjectId();
const COPY = "the copy in My files";
const TABLE = "the row in the files table";

let sha: string;
beforeEach(async () => {
	sha = await sha256(COPY);
	configured.value = true;
	warn.mockReset();
	readCustodialAttachment.mockReset().mockResolvedValue(new Blob([COPY]));
	readGuestAttachment.mockReset().mockResolvedValue(new Blob([COPY]));
	getFileByFilename.mockReset().mockResolvedValue({
		filename: `${conv}-${sha}`,
		conversationId: conv.toString(),
		mime: "text/plain",
		data: Buffer.from(TABLE),
	});
});

const text = (f: { value: string }) => Buffer.from(f.value, "base64").toString();

describe("downloadFile (CUR-2183)", () => {
	it("reads the owner's My files copy, at conversations/<conversation>/<sha>/<name>, with the turn's key store, before the files table", async () => {
		const keys = { read: vi.fn() };
		const file = await downloadFile(sha, conv, { ownerId: "u1", name: "notes.txt", keys });
		expect(readCustodialAttachment).toHaveBeenCalledWith("u1", `conversations/${conv}/${sha}/notes.txt`, keys);
		expect(text(file)).toBe(COPY);
		expect(file.mime).toBe("text/plain");
		expect(file.name).toBe(`${conv}-${sha}`);
		expect(getFileByFilename).not.toHaveBeenCalled();
	});

	it("reads a long paste from the conversation's pastes folder, in one read, and hands it back as a paste", async () => {
		const file = await downloadFile(sha, conv, {
			ownerId: "u1",
			name: "Pasted Content",
			mime: "application/vnd.chatui.clipboard",
		});
		expect(readCustodialAttachment).toHaveBeenCalledTimes(1);
		expect(readCustodialAttachment).toHaveBeenCalledWith("u1", `conversations/${conv}/pastes/${sha}/Pasted Content`, undefined);
		expect(file.mime).toBe("application/vnd.chatui.clipboard");
		expect(text(file)).toBe(COPY);
	});

	it("never trusts a paste label over the bytes: an image stored as a paste reads back as an image", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64"
		);
		const pngSha = await sha256(new TextDecoder().decode(png));
		readCustodialAttachment.mockResolvedValue(new Blob([png]));
		const file = await downloadFile(pngSha, conv, { ownerId: "u1", name: "x", mime: "application/vnd.chatui.clipboard" });
		expect(file.mime).toBe("image/png");
	});

	it("reads a guest conversation's copy from its session, never from an account's folder", async () => {
		const SID = "e".repeat(64);
		const file = await downloadFile(sha, conv, { guestSessionId: SID, name: "notes.txt" });
		expect(readGuestAttachment).toHaveBeenCalledWith(SID, `conversations/${conv}/${sha}/notes.txt`, undefined);
		expect(readCustodialAttachment).not.toHaveBeenCalled();
		expect(text(file)).toBe(COPY);
		expect(getFileByFilename).not.toHaveBeenCalled();
	});

	it("a conversation moved to an account at sign-in reads the copy the move left under its former session", async () => {
		// Over the account quota, a failed copy, or a turn sent before the background move lands: the file
		// is still under guests/<sid>/, and with the bucket as its only store there is no table to fall to.
		const SID = "e".repeat(64);
		readCustodialAttachment.mockResolvedValue(null);
		const file = await downloadFile(sha, conv, { ownerId: "u1", guestSessionId: SID, name: "notes.txt" });
		expect(readCustodialAttachment).toHaveBeenCalledWith("u1", `conversations/${conv}/${sha}/notes.txt`, undefined);
		expect(readGuestAttachment).toHaveBeenCalledWith(SID, `conversations/${conv}/${sha}/notes.txt`, undefined);
		expect(text(file)).toBe(COPY);
		expect(getFileByFilename).not.toHaveBeenCalled();
	});

	it("a moved conversation whose file reached the account reads only the account's copy", async () => {
		await downloadFile(sha, conv, { ownerId: "u1", guestSessionId: "e".repeat(64), name: "notes.txt" });
		expect(readGuestAttachment).not.toHaveBeenCalled();
	});

	it("falls back to the files table with no owner or session, with no name, or with no bucket configured", async () => {
		expect(text(await downloadFile(sha, conv))).toBe(TABLE);
		expect(text(await downloadFile(sha, conv, { ownerId: "u1" }))).toBe(TABLE);
		configured.value = false;
		expect(text(await downloadFile(sha, conv, { ownerId: "u1", name: "notes.txt" }))).toBe(TABLE);
		expect(readCustodialAttachment).not.toHaveBeenCalled();
	});

	it("falls back to the files table when the attachment has no copy", async () => {
		readCustodialAttachment.mockResolvedValue(null);
		expect(text(await downloadFile(sha, conv, { ownerId: "u1", name: "notes.txt" }))).toBe(TABLE);
	});

	it("refuses a copy whose bytes no longer hash to the reference, and says so in the log", async () => {
		readCustodialAttachment.mockResolvedValue(new Blob(["something else under that path"]));
		expect(text(await downloadFile(sha, conv, { ownerId: "u1", name: "notes.txt" }))).toBe(TABLE);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("logs a bucket error rather than hiding it, then falls back", async () => {
		readCustodialAttachment.mockRejectedValue(new Error("503"));
		expect(text(await downloadFile(sha, conv, { ownerId: "u1", name: "notes.txt" }))).toBe(TABLE);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	// A bucket-only attachment has no table row, so a read error must not fall through to the table:
	// that would come back as 404 and the turn would answer without the file (CUR-3291).
	it("rejects a bucket-only attachment with AttachmentReadError, never 404, when the bucket errors twice", async () => {
		readCustodialAttachment.mockRejectedValue(new HubApiError("https://huggingface.co/buckets/x", 429));
		getFileByFilename.mockResolvedValue(undefined);
		const read = downloadFile(sha, conv, { ownerId: "u1", name: "notes.txt" });
		await expect(read).rejects.toBeInstanceOf(AttachmentReadError);
		expect(readCustodialAttachment).toHaveBeenCalledTimes(2);
	});

	it("reads a bucket-only attachment when the retry after one Hub 5xx succeeds", async () => {
		readCustodialAttachment
			.mockReset()
			.mockRejectedValueOnce(new HubApiError("https://huggingface.co/buckets/x", 503))
			.mockResolvedValueOnce(new Blob([COPY]));
		getFileByFilename.mockResolvedValue(undefined);
		expect(text(await downloadFile(sha, conv, { ownerId: "u1", name: "notes.txt" }))).toBe(COPY);
		expect(warn).not.toHaveBeenCalled();
	});

	it("reads once and falls back on an error a retry cannot fix, so a refused read is not called a busy store", async () => {
		readCustodialAttachment.mockRejectedValue(new HubApiError("https://huggingface.co/buckets/x", 403));
		getFileByFilename.mockResolvedValue(undefined);
		await expect(downloadFile(sha, conv, { ownerId: "u1", name: "notes.txt" })).rejects.toMatchObject({ status: 404 });
		expect(readCustodialAttachment).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("waits before the retry rather than reading again in the same burst", async () => {
		vi.useFakeTimers();
		try {
			readCustodialAttachment
				.mockReset()
				.mockRejectedValueOnce(new HubApiError("https://huggingface.co/buckets/x", 429))
				.mockResolvedValueOnce(new Blob([COPY]));
			const read = downloadFile(sha, conv, { ownerId: "u1", name: "notes.txt" });
			await vi.advanceTimersByTimeAsync(0);
			expect(readCustodialAttachment).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(300);
			expect(text(await read)).toBe(COPY);
			expect(readCustodialAttachment).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still 404s when neither store has the file", async () => {
		readCustodialAttachment.mockResolvedValue(null);
		getFileByFilename.mockResolvedValue(undefined);
		await expect(downloadFile(sha, conv, { ownerId: "u1", name: "notes.txt" })).rejects.toMatchObject({
			status: 404,
		});
	});
});
