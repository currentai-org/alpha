import { describe, expect, it } from "vitest";
import {
	CUSTODIAL_MAX_FILES_PER_USER,
	CUSTODIAL_MAX_TOTAL_BYTES_PER_USER,
	STORAGE_BUSY_MESSAGE,
	storageRefusalMessage,
	storageRefusalRecovery,
	storageUsage,
} from "./custodialUpload";
import { UPLOAD_NOT_SCANNED_MESSAGE } from "$lib/chat/server/storage/csamScan";
import { UNSCANNABLE_FILE_MESSAGE } from "$lib/chat/server/storage/embeddedImageScan";
import { tooManyImagesMessage } from "$lib/chat/server/storage/uploadImageGuard";

const BYTES = CUSTODIAL_MAX_TOTAL_BYTES_PER_USER;
const FILES = CUSTODIAL_MAX_FILES_PER_USER;

describe("storageUsage (CUR-2631)", () => {
	it("stays quiet below 80% of both caps", () => {
		expect(storageUsage(BYTES * 0.79, FILES * 0.79)).toEqual({ fraction: 0.79 });
	});

	it("warns with the percentage once stored bytes pass 80%", () => {
		const { fraction, warning } = storageUsage(BYTES * 0.85, 3);
		expect(fraction).toBeCloseTo(0.85);
		expect(warning).toBe("85% of your storage is used. Delete files you no longer need to keep room.");
	});

	it("measures against whichever cap is closer, so many small files still warn", () => {
		const { fraction, warning } = storageUsage(1_000, FILES * 0.9);
		expect(fraction).toBeCloseTo(0.9);
		expect(warning).toBe(`${FILES * 0.9} of ${FILES} files used. Delete files you no longer need to keep room.`);
	});

	it("says full, and names the cap that is full, at 100%", () => {
		expect(storageUsage(BYTES, 1).warning).toBe("Your storage is full. Delete a file to add more.");
		expect(storageUsage(1_000, FILES).warning).toBe(
			`You've reached the ${FILES}-file limit. Delete a file to add more.`,
		);
		expect(storageUsage(BYTES * 2, 1).fraction).toBe(1);
	});
});

describe("storageRefusalMessage (CUR-2631)", () => {
	it("names the limit and the way out for each limit the guard refuses with", () => {
		expect(storageRefusalMessage(413, "")).toBe(
			"That file is over the 4.4 MB limit per file. Compress it or split it, then add it again.",
		);
		expect(storageRefusalMessage(507, "")).toBe("Your storage is full (250 MB). Delete a file to add more.");
		expect(storageRefusalMessage(415, "")).toMatch(/^That file type isn't supported\. Add a /);
	});

	it("turns the 429's Retry-After into whole minutes, rounded up", () => {
		expect(storageRefusalMessage(429, "", 61)).toBe(
			"You can add 60 files an hour, and you've reached that. Try again in 2 minutes.",
		);
		expect(storageRefusalMessage(429, "", 5)).toMatch(/Try again in 1 minute\.$/);
		expect(storageRefusalMessage(429, "")).toMatch(/Try again shortly\.$/);
	});

	it("falls back to the caller's message for a status it has no copy for", () => {
		expect(storageRefusalMessage(500, "Upload failed.")).toBe("Upload failed.");
		// A 503 is either the scanner or Hugging Face throttling us; the server's line says which. (CUR-3120)
		expect(storageRefusalMessage(503, STORAGE_BUSY_MESSAGE)).toBe(STORAGE_BUSY_MESSAGE);
		expect(storageRefusalMessage(503, UPLOAD_NOT_SCANNED_MESSAGE)).toBe(UPLOAD_NOT_SCANNED_MESSAGE);
		expect(storageRefusalMessage(502, "")).toBe("Upload failed (502).");
	});

	it("shows the server's own reason for a 422, not one generic line for every content refusal (CUR-4662)", () => {
		const tooMany = tooManyImagesMessage(41);
		expect(storageRefusalMessage(422, tooMany)).toBe(tooMany);
		expect(storageRefusalMessage(422, UNSCANNABLE_FILE_MESSAGE)).toBe(UNSCANNABLE_FILE_MESSAGE);
		// A 422 with no message body (a non-JSON error page) still gets a sentence.
		expect(storageRefusalMessage(422, "")).toBe("This file can't be stored here, so it wasn't added.");
	});

	it("says a scanner outage in My files in the same words chat uses (CUR-3591)", () => {
		// The client words the 503 itself, so the server sending chat's line is not enough on its own.
		expect(storageRefusalMessage(503, "")).toBe(UPLOAD_NOT_SCANNED_MESSAGE);
	});
});

describe("storageRefusalRecovery (CUR-2450)", () => {
	it("offers no retry for a refusal the same file would get again (size, type, content match)", () => {
		expect(storageRefusalRecovery(413)).toBe("remove");
		expect(storageRefusalRecovery(415)).toBe("remove");
		expect(storageRefusalRecovery(422)).toBe("remove");
	});

	it("keeps the retry where waiting or freeing room can change the answer", () => {
		expect(storageRefusalRecovery(429)).toBe("retry");
		expect(storageRefusalRecovery(503)).toBe("retry");
		expect(storageRefusalRecovery(507)).toBe("retry");
		expect(storageRefusalRecovery(500)).toBe("retry");
	});
});
