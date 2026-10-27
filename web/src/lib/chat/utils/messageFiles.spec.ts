import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.fn<(file: File) => Promise<string>>();
vi.mock("$lib/chat/utils/file2base64", () => ({ default: (file: File) => read(file) }));

const { encodeMessageFiles } = await import("./messageFiles");

describe("encodeMessageFiles", () => {
	beforeEach(() => {
		read.mockReset();
		read.mockImplementation(async (file) => `b64:${file.name}`);
	});

	it("reads each attached file once, so the conversation page reuses the landing page's encode (CUR-3402, CUR-3506)", async () => {
		const photo = new File(["x"], "IMG_4032.jpg", { type: "image/jpeg" });
		const first = await encodeMessageFiles([photo]);
		const second = await encodeMessageFiles([photo]);
		expect(read).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
		expect(first).toEqual([{ type: "base64", value: "b64:IMG_4032.jpg", mime: "image/jpeg", name: "IMG_4032.jpg" }]);
	});

	it("reads a different file of the same name on its own", async () => {
		await encodeMessageFiles([new File(["a"], "notes.txt", { type: "text/plain" })]);
		await encodeMessageFiles([new File(["b"], "notes.txt", { type: "text/plain" })]);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("tries a file again after a failed read rather than repeating the failure", async () => {
		const photo = new File(["x"], "IMG_4032.jpg", { type: "image/jpeg" });
		read.mockRejectedValueOnce(new Error("NotReadableError"));
		await expect(encodeMessageFiles([photo])).rejects.toThrow("NotReadableError");
		await expect(encodeMessageFiles([photo])).resolves.toHaveLength(1);
		expect(read).toHaveBeenCalledTimes(2);
	});
});
