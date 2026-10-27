import { afterEach, describe, expect, it, vi } from "vitest";
import { writeClipboard } from "./writeClipboard";

function fakeDocument(execResult: boolean | "throw") {
	const area = { value: "", style: {}, setAttribute: vi.fn(), select: vi.fn() };
	const execCommand = vi.fn(() => {
		if (execResult === "throw") throw new Error("blocked");
		return execResult;
	});
	vi.stubGlobal("document", {
		createElement: () => area,
		body: { appendChild: vi.fn(), removeChild: vi.fn() },
		execCommand,
	});
	return { area, execCommand };
}

afterEach(() => vi.unstubAllGlobals());

describe("writeClipboard (CUR-2823)", () => {
	it("uses the Clipboard API when it accepts, and never touches execCommand", async () => {
		const writeText = vi.fn(async () => {});
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		const { execCommand } = fakeDocument(true);
		expect(await writeClipboard("hello")).toBe(true);
		expect(writeText).toHaveBeenCalledWith("hello");
		expect(execCommand).not.toHaveBeenCalled();
	});

	it("falls back to execCommand when the Clipboard API refuses, carrying the same text", async () => {
		vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
		const { area, execCommand } = fakeDocument(true);
		expect(await writeClipboard("hello")).toBe(true);
		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(area.value).toBe("hello");
	});

	it("falls back when there is no Clipboard API at all, as in an insecure context", async () => {
		vi.stubGlobal("navigator", {});
		const { execCommand } = fakeDocument(true);
		expect(await writeClipboard("hello")).toBe(true);
		expect(execCommand).toHaveBeenCalledWith("copy");
	});

	it("reports false (so the control can say it couldn't copy) when both paths refuse", async () => {
		vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
		fakeDocument(false);
		expect(await writeClipboard("hello")).toBe(false);
		fakeDocument("throw");
		expect(await writeClipboard("hello")).toBe(false);
	});
});
