import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, it, expect, afterEach } from "vitest";
import Page from "./+page.svelte";

// Deleting a conversation detaches its reports, so each report row holds its own copy of
// the answer. A person triaging reads that copy here. These tests pin that a detached report still
// shows what was wrong, and that each row has an anchor a shared link can point at.

function report(overrides: Record<string, unknown>) {
	return {
		id: "r1",
		conversationId: null,
		messageId: null,
		userId: null,
		sessionId: "s1",
		reason: "language",
		category: null,
		detail: null,
		answerText: null,
		answerModel: null,
		createdAt: new Date("2026-09-30T08:00:00Z"),
		...overrides,
	};
}

function renderWith(reports: ReturnType<typeof report>[]) {
	return render(Page, {
		data: { needsLogin: false, authConfigured: true, reports } as never,
		form: null as never,
	});
}

describe("admin reports page", () => {
	afterEach(() => cleanup());

	it("shows the kept answer and its model for a report whose conversation was deleted", async () => {
		renderWith([
			report({ answerText: "Die Aare fliesst durch Bern.", answerModel: "served-model" }),
		]);

		await expect.element(page.getByText("Die Aare fliesst durch Bern.")).toBeVisible();
		await expect.element(page.getByText("served-model")).toBeVisible();
		await expect.element(page.getByText("It didn't work in my language")).toBeVisible();
	});

	it("gives every row an anchor named after the report id", async () => {
		renderWith([report({ id: "abc123", answerText: "x" })]);
		await expect.element(page.getByText("x", { exact: true })).toBeVisible();
		expect(document.querySelector("#report-abc123")).not.toBeNull();
	});
});
