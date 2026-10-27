import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CopyToClipBoardBtn from "./CopyToClipBoardBtn.svelte";

// The code-block copy button returned early on a refused clipboard, so the visitor saw
// nothing and couldn't tell the copy had failed. (CUR-2920)
describe("CopyToClipBoardBtn — a refused copy says so (CUR-2920)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		cleanup();
	});

	it("shows \"Couldn't copy\" when both the Clipboard API and execCommand refuse", async () => {
		vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
		vi.spyOn(document, "execCommand").mockReturnValue(false);
		await render(CopyToClipBoardBtn, { value: "print(1)" });

		await page.getByRole("button", { name: "Copy to clipboard" }).click();

		await expect.element(page.getByText("Couldn't copy")).toBeVisible();
		await expect.element(page.getByText("Copied")).not.toBeInTheDocument();
	});

	it('shows "Copied" when the copy goes through', async () => {
		vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
		await render(CopyToClipBoardBtn, { value: "print(1)" });

		await page.getByRole("button", { name: "Copy to clipboard" }).click();

		await expect.element(page.getByText("Copied")).toBeVisible();
	});
});
