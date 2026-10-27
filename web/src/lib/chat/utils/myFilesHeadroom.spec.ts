import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_ATTACHMENTS_MAX_BYTES, CHAT_ATTACHMENTS_MAX_COUNT } from "$lib/chat/constants/uploadLimits";
import { CUSTODIAL_MAX_FILES_PER_USER, CUSTODIAL_MAX_TOTAL_BYTES_PER_USER } from "$lib/chat/constants/custodialUpload";

vi.mock("$app/state", () => ({ page: { data: { storageViewEnabled: true } } }));
vi.mock("$lib/chat/paths", () => ({ base: "/chat" }));

const { HEADROOM_REUSE_MS } = await import("./myFilesHeadroom");
// A fresh module per test, so the cache starts empty without calling the reset under test.
let m: typeof import("./myFilesHeadroom");
const fetchAttachmentRooms = () => m.fetchAttachmentRooms();
const myFilesChanged = () => m.myFilesChanged();

let listing: { size: number }[] = [];
const fetchMock = vi.fn(async (url: string) => {
	if (url.endsWith("/api/storage")) return new Response(JSON.stringify({ files: listing }), { status: 200 });
	return new Response("{}", { status: 404 });
});
const listings = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/storage")).length;

/** A listing that leaves `files` free slots (at most one fewer than the limit) and `bytes` of room. */
function leaving(files: number, bytes: number): { size: number }[] {
	const zeros = Array.from({ length: CUSTODIAL_MAX_FILES_PER_USER - files - 1 }, () => ({ size: 0 }));
	return [...zeros, { size: CUSTODIAL_MAX_TOTAL_BYTES_PER_USER - bytes }];
}

beforeEach(async () => {
	vi.resetModules();
	m = await import("./myFilesHeadroom");
	fetchMock.mockClear();
	vi.stubGlobal("fetch", fetchMock);
	vi.useFakeTimers({ toFake: ["Date"] });
	listing = [];
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("fetchAttachmentRooms reuses a roomy My files headroom (CUR-3681)", () => {
	it("lists My files once for two attaches a few seconds apart when there is plenty of room", async () => {
		await fetchAttachmentRooms();
		vi.setSystemTime(Date.now() + 5_000);
		const rooms = await fetchAttachmentRooms();
		expect(listings()).toBe(1);
		expect(rooms[0]).toMatchObject({ files: CUSTODIAL_MAX_FILES_PER_USER });
	});

	it("lists again once the reuse window has passed", async () => {
		await fetchAttachmentRooms();
		vi.setSystemTime(Date.now() + HEADROOM_REUSE_MS + 1);
		await fetchAttachmentRooms();
		expect(listings()).toBe(2);
	});

	it("never reuses a headroom short of two full messages, so a refusal always comes from a fresh listing", async () => {
		listing = leaving(CUSTODIAL_MAX_FILES_PER_USER - 1, 2 * CHAT_ATTACHMENTS_MAX_BYTES - 1);
		await fetchAttachmentRooms();
		await fetchAttachmentRooms();
		expect(listings()).toBe(2);

		vi.setSystemTime(Date.now() + HEADROOM_REUSE_MS + 1);
		fetchMock.mockClear();
		listing = leaving(2 * CHAT_ATTACHMENTS_MAX_COUNT - 1, CUSTODIAL_MAX_TOTAL_BYTES_PER_USER);
		await fetchAttachmentRooms();
		await fetchAttachmentRooms();
		expect(listings()).toBe(2);
	});

	it("lists again after My files changes inside the reuse window, so an upload there is counted", async () => {
		await fetchAttachmentRooms();
		vi.setSystemTime(Date.now() + 5_000);
		listing = leaving(CUSTODIAL_MAX_FILES_PER_USER - 1, CHAT_ATTACHMENTS_MAX_BYTES - 1);
		myFilesChanged();
		const rooms = await fetchAttachmentRooms();
		expect(listings()).toBe(2);
		expect(rooms[0]).toMatchObject({ bytes: CHAT_ATTACHMENTS_MAX_BYTES - 1 });
	});

	it("shares one listing between attaches that land at the same moment", async () => {
		await Promise.all([fetchAttachmentRooms(), fetchAttachmentRooms(), fetchAttachmentRooms()]);
		expect(listings()).toBe(1);
	});

	it("does not remember a failed listing, so the next attach asks again", async () => {
		fetchMock.mockImplementationOnce(async () => new Response("busy", { status: 503 }));
		const first = await fetchAttachmentRooms();
		expect(first.some((r) => r.refusal === undefined)).toBe(false);
		await fetchAttachmentRooms();
		expect(listings()).toBe(2);
	});
});
