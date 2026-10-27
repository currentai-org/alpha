import ChatMessage from "./ChatMessage.harness.svelte";
import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, expect, it, afterEach, vi } from "vitest";
import type { Message } from "$lib/chat/types/Message";
import { get } from "svelte/store";
import { refusedEdit } from "$lib/chat/stores/refusedEdit";
import { sendHeldUntil } from "$lib/chat/stores/errors";

// The edit box reads the length cap off page.data, which has no SvelteKit router behind it here, so
// $app/state is a bare object carrying only the fields ChatMessage reads.
vi.mock("$app/state", () => ({ page: { data: { messageLengthLimit: 20 }, params: {} } }));

const question: Message = {
	from: "user",
	id: "22222222-2222-4222-8222-222222222222",
	content: "What is the capital of France?",
};

describe("ChatMessage — an edit over the length cap (CUR-2825)", () => {
	afterEach(() => {
		cleanup();
	});

	const editBox = () => page.getByRole("textbox", { name: "Edit your message" });
	const send = () => page.getByRole("button", { name: "Send" });

	it("refuses in the box and keeps it open with the text, sending nothing", async () => {
		const sent: unknown[] = [];
		await render(ChatMessage, {
			message: question,
			loading: false,
			editMsdgId: question.id,
			onretry: (payload: unknown) => sent.push(payload),
		});
		const tooLong = "x".repeat(21);
		await editBox().fill(tooLong);
		await send().click();
		await expect.element(page.getByRole("alert")).toHaveTextContent(
			"Message too long: 21 characters, the limit is 20. Cut 1 to send it; your text is still here."
		);
		await expect.element(editBox()).toHaveValue(tooLong);
		expect(sent).toEqual([]);
	});

	it("reopens with the refused text and the server's reason when the server refuses an edit", async () => {
		refusedEdit.set({ id: question.id, text: "And of Spain?", reason: "Too many messages. Try again in a minute." });
		await render(ChatMessage, { message: question, loading: false, editMsdgId: question.id, onretry: () => {} });
		await expect.element(page.getByRole("alert")).toHaveTextContent("Too many messages. Try again in a minute.");
		await expect.element(editBox()).toHaveValue("And of Spain?");
		// Held until the person closes the box, so a resync that remounts the message reopens it the same way.
		expect(get(refusedEdit)?.id).toBe(question.id);
		await page.getByRole("button", { name: "Cancel" }).click();
		expect(get(refusedEdit)).toBeNull();
	});

	it("sends an edit within the cap as a new version", async () => {
		const sent: unknown[] = [];
		await render(ChatMessage, {
			message: question,
			loading: false,
			editMsdgId: question.id,
			onretry: (payload: unknown) => sent.push(payload),
		});
		await editBox().fill("And of Spain?");
		await send().click();
		expect(sent).toEqual([{ content: "And of Spain?", id: question.id }]);
	});

	it("keeps what the person typed when the message updates while the box is open", async () => {
		const { rerender } = await render(ChatMessage, {
			message: question,
			loading: false,
			editMsdgId: question.id,
			onretry: () => {},
		});
		await editBox().fill("And of Spain?");
		// A title arriving, or the reload after a fast answer's stream, hands the message in again as a new object.
		await rerender({ message: { ...question, updatedAt: new Date() } });
		await expect.element(editBox()).toHaveValue("And of Spain?");
	});

	// Our own message limit says how long its window has left, and the page holds Send for
	// that long (sendHeldUntil). The edit box must not keep its Send live beside "wait a minute": a press only
	// meets the same refusal and pushes the window further out. edit-refused.spec.ts test 3 drives this
	// through the page live; this pins the edit box's own half (SOL-206). (CUR-3410)
	it("holds the edit box Send while our message limit's wait runs, counts it down, then gives Send back (CUR-3410)", async () => {
		refusedEdit.set({
			id: question.id,
			text: "And of Spain?",
			reason: "You are sending messages too fast. Please wait a minute and try again.",
		});
		sendHeldUntil.set(Date.now() + 3_000);
		try {
			await render(ChatMessage, { message: question, loading: false, editMsdgId: question.id, onretry: () => {} });
			await expect
				.element(page.getByText(/^You can send again in \d+ seconds?\.$/), {
					message: "the refused edit gave no sign of when Send will work",
				})
				.toBeVisible();
			await expect.element(send(), { message: "Send stayed live while the server said to wait" }).toBeDisabled();
			await expect
				.element(send(), { timeout: 10_000, message: "Send never came back once the wait was over" })
				.toBeEnabled();
		} finally {
			sendHeldUntil.set(undefined);
			refusedEdit.set(null);
		}
	});
});
