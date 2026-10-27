import { describe, it, expect } from "vitest";
import {
	PLATFORM_BODY_BYTES,
	CHAT_MESSAGE_HEADROOM_BYTES,
	CHAT_ATTACHMENTS_MAX_BYTES,
	VOICE_RECORDING_MAX_BYTES,
	base64Bytes,
	admitAttachments,
	chatAttachmentsTooLargeMessage,
	myFilesFullMessage,
	myFilesHeadroom,
	attachmentAllowanceMessage,
	attachmentAllowanceNearMessage,
	ATTACHMENT_ALLOWANCE,
} from "./uploadLimits";
import {
	CUSTODIAL_MAX_BYTES_PER_FILE,
	CUSTODIAL_MAX_FILES_PER_USER,
	CUSTODIAL_MAX_TOTAL_BYTES_PER_USER,
} from "./custodialUpload";
import { CLIPBOARD_MIME } from "./mime";

const file = (bytes: number, name = "f", type = "") => new File([new Uint8Array(bytes)], name, { type });

describe("upload limits fit the transport that carries them (CUR-2631)", () => {
	it("a message at the chat attachment limit, base64-encoded with its headroom, fits the platform body cap", () => {
		expect(base64Bytes(CHAT_ATTACHMENTS_MAX_BYTES) + CHAT_MESSAGE_HEADROOM_BYTES).toBeLessThanOrEqual(
			PLATFORM_BODY_BYTES
		);
	});

	it("raw single-file uploads (voice, My files) stay under the platform body cap", () => {
		expect(VOICE_RECORDING_MAX_BYTES).toBeLessThan(PLATFORM_BODY_BYTES);
		expect(CUSTODIAL_MAX_BYTES_PER_FILE).toBeLessThan(PLATFORM_BODY_BYTES);
	});

	it("the refusal names the limit in the same decimal units the server enforces", () => {
		expect(chatAttachmentsTooLargeMessage()).toContain("3.0 MB per message");
	});
});

describe("admitAttachments", () => {
	it("admits files while the message total stays within the limit and refuses the rest with the shared sentence", () => {
		const half = Math.floor(CHAT_ATTACHMENTS_MAX_BYTES / 2);
		const out = admitAttachments([file(half)], [file(half - 1, "fits"), file(10, "over"), file(1, "fits too")]);
		expect(out.admitted.map((f) => f.name)).toEqual(["fits", "fits too"]);
		expect(out.refusal).toBe(chatAttachmentsTooLargeMessage());
	});

	it("returns no refusal when everything fits", () => {
		expect(admitAttachments([], [file(1)])).toEqual({ admitted: [expect.any(File)] });
	});

	it("refuses a single file that alone exceeds the limit", () => {
		const out = admitAttachments([], [file(CHAT_ATTACHMENTS_MAX_BYTES + 1)]);
		expect(out.admitted).toEqual([]);
		expect(out.refusal).toBeDefined();
	});
});

describe("admitAttachments against My files' headroom (CUR-3235)", () => {
	it("refuses a file My files has no bytes left for, with the line that says to delete one", () => {
		const out = admitAttachments([], [file(10, "big"), file(1, "small")], { files: 5, bytes: 5 });
		expect(out.admitted.map((f) => f.name)).toEqual(["small"]);
		expect(out.refusal).toBe(myFilesFullMessage());
	});

	it("counts the files already waiting on the composer against the headroom", () => {
		const out = admitAttachments([file(4, "waiting")], [file(4, "next")], { files: 5, bytes: 6 });
		expect(out.admitted).toEqual([]);
		expect(out.refusal).toBe(myFilesFullMessage());
	});

	it("refuses once My files has no file slots left, whatever the size", () => {
		const out = admitAttachments([], [file(1, "a"), file(1, "b")], { files: 1, bytes: 1_000 });
		expect(out.admitted.map((f) => f.name)).toEqual(["a"]);
		expect(out.refusal).toBe(myFilesFullMessage());
	});

	it("never counts a long paste, which is message text kept out of My files", () => {
		const out = admitAttachments([file(9, "earlier paste", CLIPBOARD_MIME)], [file(9, "paste", CLIPBOARD_MIME)], {
			files: 0,
			bytes: 0,
		});
		expect(out).toEqual({ admitted: [expect.any(File)] });
	});

	it("with no headroom known, admits by the per-message limit alone, so a failed listing never blocks", () => {
		expect(admitAttachments([], [file(1)], undefined)).toEqual({ admitted: [expect.any(File)] });
	});

	it("names the account's limit in the same decimal units My files shows", () => {
		expect(myFilesFullMessage()).toBe("Your files are full (250 MB). Delete a file in My files to attach this one.");
	});
});

describe("myFilesHeadroom", () => {
	it("is what the account's limits leave after the listing, never below zero", () => {
		expect(myFilesHeadroom([{ size: 100 }, { size: 50 }])).toEqual({
			files: CUSTODIAL_MAX_FILES_PER_USER - 2,
			bytes: CUSTODIAL_MAX_TOTAL_BYTES_PER_USER - 150,
		});
		expect(myFilesHeadroom([{ size: CUSTODIAL_MAX_TOTAL_BYTES_PER_USER + 1 }]).bytes).toBe(0);
	});
});

describe("admitAttachments against the 24-hour allowance as well as My files (CUR-3235)", () => {
	const allowance = (files: number, bytes = 1_000) => ({
		files,
		bytes,
		refusal: attachmentAllowanceMessage({ guest: true, resetsInMs: 3 * 3_600_000 }),
	});

	it("refuses with the allowance's own line when My files has room and the allowance has none", () => {
		const out = admitAttachments([], [file(1, "a"), file(1, "b")], [{ files: 5, bytes: 1_000 }, allowance(1)]);
		expect(out.admitted.map((f) => f.name)).toEqual(["a"]);
		expect(out.refusal).toBe(
			"You've attached as many files as a guest can in a day. You can attach more in about 3 hours. Sign in for a larger allowance."
		);
	});

	it("spends each admitted file against every room, so the tighter one decides", () => {
		const out = admitAttachments([file(1, "waiting")], [file(1, "a"), file(1, "b")], [{ files: 5, bytes: 1_000 }, allowance(2)]);
		expect(out.admitted.map((f) => f.name)).toEqual(["a"]);
	});

	it("tells an account to wait, with no sign-in line", () => {
		expect(attachmentAllowanceMessage({ guest: false, resetsInMs: 20 * 60_000 })).toBe(
			"You've attached as many files as Alpha takes in a day. You can attach more in about 20 minutes."
		);
	});

	it("tells a guest whose network ran out that it is the shared Wi-Fi, not them (CUR-3600)", () => {
		expect(attachmentAllowanceMessage({ guest: true, network: true, resetsInMs: 3 * 3_600_000 })).toBe(
			"Too many files have been attached from your network today. If you're at an event sharing Wi-Fi, sign in to attach more, or you can attach more in about 3 hours."
		);
	});
});

describe("the near-limit line under the composer's files (CUR-3235)", () => {
	const guest = ATTACHMENT_ALLOWANCE.guest;
	const near = (files: number, bytes: number, isGuest = true) =>
		attachmentAllowanceNearMessage({
			left: { files, bytes },
			limit: guest,
			guest: isGuest,
			resetsInMs: 3 * 3_600_000,
		});
	const room = (files: number, bytes: number) => ({
		files,
		bytes,
		warning: (left: { files: number; bytes: number }) =>
			attachmentAllowanceNearMessage({ left, limit: guest, guest: true, resetsInMs: 3 * 3_600_000 }),
	});

	it("says nothing while more than a fifth of the allowance is left in both files and bytes", () => {
		expect(near(guest.files, guest.bytes)).toBeUndefined();
		expect(near(3, guest.bytes)).toBeUndefined();
	});

	it("says how much is left, when it frees up, and offers a guest sign-in, once files or bytes reach a fifth", () => {
		expect(near(2, guest.bytes)).toBe(
			"You can attach 2 more files today, up to 25 MB. More frees up in about 3 hours. Sign in for a larger allowance."
		);
		expect(near(9, guest.bytes / 5)).toMatch(/^You can attach 9 more files today, up to 5\.0 MB\./);
		expect(near(1, 1_000, false)).toBe("You can attach 1 more file today, up to 1.0 KB. More frees up in about 3 hours.");
	});

	it("leaves a spent allowance to the refusal, so the two lines never both show", () => {
		expect(near(0, guest.bytes)).toBeUndefined();
		expect(near(2, 0)).toBeUndefined();
	});

	it("warns from what is left after the files waiting on the composer and the ones just added", () => {
		const out = admitAttachments([file(1, "waiting")], [file(1, "a")], [room(4, guest.bytes)]);
		expect(out.admitted.map((f) => f.name)).toEqual(["a"]);
		expect(out.warning).toMatch(/^You can attach 2 more files today/);
		expect(admitAttachments([], [file(1, "a")], [room(guest.files, guest.bytes)]).warning).toBeUndefined();
	});

	it("shows the refusal and no warning when a file was refused", () => {
		const out = admitAttachments([], [file(1, "a"), file(1, "b")], [{ ...room(1, guest.bytes), refusal: "spent" }]);
		expect(out).toEqual({ admitted: [expect.objectContaining({ name: "a" })], refusal: "spent" });
	});
});
