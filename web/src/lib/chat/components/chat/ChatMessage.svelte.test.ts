import ChatMessage from "./ChatMessage.harness.svelte";
import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, expect, it, afterEach } from "vitest";
import type { Message } from "$lib/chat/types/Message";
import {
	HELD_REASONING_STATUS,
	MessageReasoningUpdateType,
	MessageUpdateStatus,
	MessageUpdateType,
} from "$lib/chat/types/MessageUpdate";
import { plainTextOf } from "$lib/chat/utils/copyText";

// A generation the watchdog kills (genTimeoutMs, ~45s) sends an empty `finalAnswer` and a real
// `status:error` update over the wire, possibly with zero tokens streamed (CUR-1748). Neither
// `showsEmptyAnswerNotice` nor `showsInterruptedNotice` renders for that case (both explicitly
// exclude `status === 'error'`), so without the error notice the message bubble stays permanently
// blank in the transcript, the "reads as a bug" shape ChatMessage.svelte's CUR-113 comment warns
// about for the empty-answer case.
const baseMessage: Message = {
	from: "assistant",
	id: "11111111-1111-4111-8111-111111111111",
	content: "",
};

describe("ChatMessage — error notice (CUR-1748)", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows the server's own error message in the bubble for a watchdog-killed turn", async () => {
		const message: Message = {
			...baseMessage,
			updates: [
				{ type: MessageUpdateType.FinalAnswer, text: "", interrupted: true },
				{
					type: MessageUpdateType.Status,
					status: MessageUpdateStatus.Error,
					statusCode: 504,
					message: "The request took too long to respond. Please try again.",
				},
			],
		};
		await render(ChatMessage, { message, loading: false });
		await expect
			.element(page.getByText("The request took too long to respond. Please try again."))
			.toBeInTheDocument();
	});

	it("still shows the error notice over partial content that streamed before the kill", async () => {
		const message: Message = {
			...baseMessage,
			content: "Voici la tra",
			updates: [
				{ type: MessageUpdateType.FinalAnswer, text: "Voici la tra", interrupted: true },
				{
					type: MessageUpdateType.Status,
					status: MessageUpdateStatus.Error,
					statusCode: 504,
					message: "The request took too long to respond. Please try again.",
				},
			],
		};
		await render(ChatMessage, { message, loading: false });
		await expect.element(page.getByText("Voici la tra")).toBeInTheDocument();
		await expect
			.element(page.getByText("The request took too long to respond. Please try again."))
			.toBeInTheDocument();
	});

	it("does not show the error notice while the turn is still streaming", async () => {
		const message: Message = { ...baseMessage };
		await render(ChatMessage, { message, loading: true });
		await expect
			.element(page.getByText("The request took too long to respond. Please try again."))
			.not.toBeInTheDocument();
	});

	it("does not show the error notice on a clean, complete turn", async () => {
		const message: Message = {
			...baseMessage,
			content: "Bonjour.",
			updates: [{ type: MessageUpdateType.FinalAnswer, text: "Bonjour.", interrupted: false }],
		};
		await render(ChatMessage, { message, loading: false });
		await expect
			.element(page.getByText("The request took too long to respond. Please try again."))
			.not.toBeInTheDocument();
	});
});

// `loading` is the page's flag for whichever turn is live, and ChatWindow passes it to every
// message. An earlier, finished answer must not read it as its own: it would lose its receipt the moment a
// follow-up is sent and look as if it were being regenerated. (CUR-1978)
describe("ChatMessage — receipt of an earlier answer while a newer turn streams (CUR-1978)", () => {
	afterEach(() => {
		cleanup();
	});

	const FIXED_LINE = "No model wrote this reply. It is a fixed notice from Alpha.";
	const notice: Message = {
		...baseMessage,
		content: "I can't yet answer reliably in Yucatec Maya.",
		fixedReply: { kind: "low-resource-language" },
		updates: [
			{ type: MessageUpdateType.FixedReply, kind: "low-resource-language" },
			{
				type: MessageUpdateType.FinalAnswer,
				text: "I can't yet answer reliably in Yucatec Maya.",
				interrupted: false,
			},
			{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
		],
	};

	it("keeps a finished earlier answer's receipt while a later turn is loading", async () => {
		await render(ChatMessage, { message: notice, loading: true, isLast: false });
		await expect.element(page.getByText(FIXED_LINE)).toBeInTheDocument();
	});

	it("still holds the receipt back on the last message while its own turn is loading", async () => {
		await render(ChatMessage, { message: notice, loading: true, isLast: true });
		await expect.element(page.getByText(FIXED_LINE)).not.toBeInTheDocument();
	});
});

// A failed retry has no text and no routing record, so the answer footer (which holds the ‹ n/m ›
// switcher) never renders. The switcher must still show on an errored alternative, or the earlier answers are
// unreachable.
describe("ChatMessage — switching away from a failed retry", () => {
	afterEach(() => {
		cleanup();
	});

	const failed: Message = {
		...baseMessage,
		id: "33333333-3333-4333-8333-333333333333",
		updates: [
			{ type: MessageUpdateType.FinalAnswer, text: "", interrupted: true },
			{
				type: MessageUpdateType.Status,
				status: MessageUpdateStatus.Error,
				message: "The request took too long to respond. Please try again.",
			},
		],
	};
	const alternatives = [
		"22222222-2222-4222-8222-222222222222",
		"44444444-4444-4444-8444-444444444444",
		failed.id,
	];

	it("keeps the alternatives switcher on an errored answer, and its back arrow goes to the previous one", async () => {
		const shown: string[] = [];
		await render(ChatMessage, {
			message: failed,
			alternatives,
			loading: false,
			isLast: true,
			onshowAlternateMsg: ({ id }) => shown.push(id),
		});
		await expect.element(page.getByText("3 / 3")).toBeInTheDocument();
		await expect.element(page.getByRole("button", { name: "Next version" })).toBeDisabled();
		await page.getByRole("button", { name: "Previous version" }).click();
		expect(shown).toEqual([alternatives[1]]);
	});

	it("hides the switcher on the last message while its own turn is still loading", async () => {
		await render(ChatMessage, { message: failed, alternatives, loading: true, isLast: true });
		await expect.element(page.getByText("3 / 3")).not.toBeInTheDocument();
	});
});

// The low-resource notice ends "I can still try if you want", and Retry only regenerates the
// same notice. The button sends the visitor's yes, which the server reads as "answer anyway". (CUR-1841)
describe("ChatMessage — try anyway under the low-resource notice (CUR-1841)", () => {
	afterEach(() => {
		cleanup();
	});

	const notice: Message = {
		...baseMessage,
		content: "I can't yet answer reliably in Quechua.",
		fixedReply: { kind: "low-resource-language" },
		updates: [
			{ type: MessageUpdateType.FixedReply, kind: "low-resource-language" },
			{
				type: MessageUpdateType.FinalAnswer,
				text: "I can't yet answer reliably in Quechua.",
				interrupted: false,
			},
			{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
		],
	};
	const tryAnyway = () => page.getByRole("button", { name: "Try anyway" });

	it("sends the visitor's yes when they press Try anyway on the last notice", async () => {
		const sent: string[] = [];
		await render(ChatMessage, {
			message: notice,
			loading: false,
			isLast: true,
			onsend: (text: string) => sent.push(text),
		});
		await tryAnyway().click();
		expect(sent).toEqual(["Please try anyway."]);
	});

	it("offers no button on an earlier notice the conversation has moved past", async () => {
		await render(ChatMessage, { message: notice, loading: false, isLast: false, onsend: () => {} });
		await expect.element(page.getByText("I can't yet answer reliably in Quechua.")).toBeInTheDocument();
		await expect.element(tryAnyway()).not.toBeInTheDocument();
	});

	it("offers no button on an ordinary answer", async () => {
		const answer: Message = {
			...baseMessage,
			content: "Bonjour.",
			updates: [{ type: MessageUpdateType.FinalAnswer, text: "Bonjour.", interrupted: false }],
		};
		await render(ChatMessage, { message: answer, loading: false, isLast: true, onsend: () => {} });
		await expect.element(page.getByText("Bonjour.")).toBeInTheDocument();
		await expect.element(tryAnyway()).not.toBeInTheDocument();
	});

	it("offers no button where nobody can send (a shared or read-only view)", async () => {
		await render(ChatMessage, { message: notice, loading: false, isLast: true });
		await expect.element(page.getByText("I can't yet answer reliably in Quechua.")).toBeInTheDocument();
		await expect.element(tryAnyway()).not.toBeInTheDocument();
	});
});

// The copy handler must not build text/plain from textContent, which keeps the screen-reader
// label and the "?" marker (pasting "Cl@ve(unverified link)?") and adds no block breaks (running a
// heading into the paragraph after it). (CUR-2421)
describe("ChatMessage — copying a selection (CUR-2421)", () => {
	afterEach(() => {
		cleanup();
	});

	const ANSWER =
		'### Prendre rendez-vous\n\nContactez [Cl@ve](https://example.org/clave "§unverified§") pour la suite.';
	const answer: Message = {
		...baseMessage,
		content: ANSWER,
		updates: [
			{ type: MessageUpdateType.FinalAnswer, text: ANSWER, interrupted: false },
			{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
		],
	};

	// Selects from the heading through the paragraph and fires the copy event the browser would.
	async function copySelectionOfAnswer(): Promise<DataTransfer> {
		await expect.element(page.getByRole("heading", { name: "Prendre rendez-vous" })).toBeVisible();
		const heading = document.querySelector("h3")!;
		const paragraph = heading.nextElementSibling!;
		const range = document.createRange();
		range.setStartBefore(heading);
		range.setEndAfter(paragraph);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		const clipboardData = new DataTransfer();
		heading.dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true }));
		return clipboardData;
	}

	it("copies an unverified link as its text alone, without the hidden label or the ? marker", async () => {
		await render(ChatMessage, { message: answer, loading: false });
		const text = (await copySelectionOfAnswer()).getData("text/plain");
		expect(text).toContain("Contactez Cl@ve pour la suite.");
		expect(text).not.toContain("(unverified link)");
		expect(text).not.toContain("?");
	});

	it("puts a line break between a heading and the paragraph after it", async () => {
		await render(ChatMessage, { message: answer, loading: false });
		const text = (await copySelectionOfAnswer()).getData("text/plain");
		expect(text).toBe("Prendre rendez-vous\n\nContactez Cl@ve pour la suite.");
	});

	it("still shows the ? marker and announces the link as unverified on screen", async () => {
		await render(ChatMessage, { message: answer, loading: false });
		await expect
			.element(page.getByRole("button", { name: "Why this link is marked unverified" }))
			.toBeVisible();
		await expect
			.element(page.getByRole("link", { name: "Cl@ve (unverified link)" }))
			.toBeInTheDocument();
	});
});

describe("plainTextOf (CUR-2421)", () => {
	const html = (markup: string) => {
		const div = document.createElement("div");
		div.innerHTML = markup;
		return div;
	};

	it("keeps code indentation inside <pre> exactly", () => {
		const root = html('<pre><code>if x:\n    <span class="k">return</span> 1\n</code></pre>');
		expect(plainTextOf(root)).toBe("if x:\n    return 1\n");
	});

	// The break before a block trims the next text's leading spaces, which inside <pre> is
	// the first line's indentation. (CUR-2911)
	it("keeps the first line's indentation in a <pre> that follows a paragraph", () => {
		const root = html("<p>Inside the loop:</p>\n<pre><code>    return 1\n</code></pre>");
		expect(plainTextOf(root)).toBe("Inside the loop:\n\n    return 1\n");
	});

	it("puts each list item on its own line", () => {
		const root = html("<p>Steps:</p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>");
		expect(plainTextOf(root)).toBe("Steps:\n\none\ntwo");
	});
});

describe("ChatMessage — a turn stopped before any text (CUR-2824)", () => {
	afterEach(() => {
		cleanup();
	});

	it("names the stop instead of saying no answer was produced", async () => {
		const message: Message = {
			...baseMessage,
			interrupted: true,
			updates: [{ type: MessageUpdateType.FinalAnswer, text: "", interrupted: true }],
		};
		await render(ChatMessage, { message, loading: false });
		await expect.element(page.getByText("Stopped before any answer arrived.")).toBeInTheDocument();
		await expect
			.element(page.getByText("No answer was produced for this message."))
			.not.toBeInTheDocument();
	});

	it("keeps the no-answer line for an empty turn that finished without a stop", async () => {
		const message: Message = {
			...baseMessage,
			updates: [{ type: MessageUpdateType.FinalAnswer, text: "", interrupted: false }],
		};
		await render(ChatMessage, { message, loading: false });
		await expect
			.element(page.getByText("No answer was produced for this message."))
			.toBeInTheDocument();
	});
});

// A failed retry has no text and no routing record, so the answer footer (which holds the ‹ n/m ›
// switcher) never renders. The switcher must still show on an errored alternative, or the earlier answers are
// unreachable.
describe("ChatMessage — switching away from a failed retry", () => {
	afterEach(() => {
		cleanup();
	});

	const failed: Message = {
		...baseMessage,
		id: "33333333-3333-4333-8333-333333333333",
		updates: [
			{ type: MessageUpdateType.FinalAnswer, text: "", interrupted: true },
			{
				type: MessageUpdateType.Status,
				status: MessageUpdateStatus.Error,
				message: "The request took too long to respond. Please try again.",
			},
		],
	};
	const alternatives = [
		"22222222-2222-4222-8222-222222222222",
		"44444444-4444-4444-8444-444444444444",
		failed.id,
	];

	it("keeps the alternatives switcher on an errored answer, and its back arrow goes to the previous one", async () => {
		const shown: string[] = [];
		await render(ChatMessage, {
			message: failed,
			alternatives,
			loading: false,
			isLast: true,
			onshowAlternateMsg: ({ id }) => shown.push(id),
		});
		await expect.element(page.getByText("3 / 3")).toBeInTheDocument();
		await expect.element(page.getByRole("button", { name: "Next version" })).toBeDisabled();
		await page.getByRole("button", { name: "Previous version" }).click();
		expect(shown).toEqual([alternatives[1]]);
	});

	it("hides the switcher on the last message while its own turn is still loading", async () => {
		await render(ChatMessage, { message: failed, alternatives, loading: true, isLast: true });
		await expect.element(page.getByText("3 / 3")).not.toBeInTheDocument();
	});
});

// An interrupted or empty turn shows a notice with its own Retry. The footer kept its Retry beside it,
// so the turn offered two, and every spec waiting on `getByRole('button', { name: 'Retry' })` failed
// strict mode the moment a degraded turn finished, reporting "no finished answer" instead of the notice.
describe("ChatMessage — one Retry per turn when a notice carries it", () => {
	afterEach(() => {
		cleanup();
	});

	it("offers exactly one Retry, the notice's, on an interrupted answer with partial text", async () => {
		const message: Message = {
			...baseMessage,
			content: "Rivers meander because",
			updates: [
				{ type: MessageUpdateType.FinalAnswer, text: "Rivers meander because", interrupted: true },
			],
		};
		await render(ChatMessage, { message, loading: false, onretry: () => {} });
		await expect
			.element(page.getByText("Response was interrupted and may be incomplete."))
			.toBeInTheDocument();
		const retries = page.getByRole("button", { name: "Retry" });
		await expect.element(retries).toBeInTheDocument();
		expect(retries.all()).toHaveLength(1);
		await expect
			.element(page.getByRole("alert").getByRole("button", { name: "Retry" }))
			.toBeInTheDocument();
	});

	it("keeps the footer's Retry on a clean, complete answer", async () => {
		const message: Message = {
			...baseMessage,
			content: "Bonjour.",
			updates: [{ type: MessageUpdateType.FinalAnswer, text: "Bonjour.", interrupted: false }],
		};
		await render(ChatMessage, { message, loading: false, onretry: () => {} });
		await expect.element(page.getByRole("button", { name: "Retry" })).toBeInTheDocument();
		await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
	});
});

// When the input screen doesn't finish, the decline tells the visitor to send it again, but the
// only way to do that was the footer's unlabelled icon, so they retyped the question and found the photo
// again. The decline carries a labelled Retry that regenerates the stored turn, photo included. (CUR-3739)
describe("ChatMessage — a could-not-check decline offers a labelled Retry (CUR-3739)", () => {
	afterEach(() => {
		cleanup();
	});

	const unscreenedDecline: Message = {
		...baseMessage,
		content:
			"We couldn't finish the safety check on this message, so it wasn't sent to the model. Nothing in it was flagged. Try a shorter message, or send it again in a moment.",
		moderation: {
			flagged: true,
			label: null,
			score: 0,
			kind: "child_safety",
			unscreened: true,
		},
		updates: [
			{
				type: MessageUpdateType.FinalAnswer,
				text: "We couldn't finish the safety check on this message, so it wasn't sent to the model. Nothing in it was flagged. Try a shorter message, or send it again in a moment.",
				interrupted: false,
			},
		],
	};

	it("shows one Retry as visible text in an alert, which retries this turn", async () => {
		const retried: string[] = [];
		await render(ChatMessage, {
			message: unscreenedDecline,
			loading: false,
			onretry: ({ id }: { id: string }) => retried.push(id),
		});
		const retry = page.getByRole("alert").getByRole("button", { name: "Retry" });
		await expect.element(retry).toBeVisible();
		await expect.element(retry).toHaveTextContent("Retry");
		expect(page.getByRole("button", { name: "Retry" }).all()).toHaveLength(1);
		await retry.click();
		expect(retried).toEqual([unscreenedDecline.id]);
	});

	it("names the badge in plain words, not the screen's plumbing", async () => {
		await render(ChatMessage, { message: unscreenedDecline, loading: false, onretry: () => {} });
		await expect.element(page.getByText("Couldn't check this message")).toBeInTheDocument();
		await expect.element(page.getByText(/safety screen didn't finish/)).not.toBeInTheDocument();
	});
});

// Every policy decline offers a review, child-safety included, since a false positive there
// needs a person most of all. (CUR-3902)
describe("ChatMessage — challenging a decline (CUR-3902)", () => {
	afterEach(() => {
		cleanup();
	});

	const declineOf = (kind: "content_policy" | "child_safety"): Message => ({
		...baseMessage,
		content: "Current AI set this limit (rule: example).",
		moderation: { flagged: true, label: null, score: 1, kind },
		updates: [
			{
				type: MessageUpdateType.FinalAnswer,
				text: "Current AI set this limit (rule: example).",
				interrupted: false,
			},
		],
	});

	it("offers Ask for a review under a content-policy decline", async () => {
		await render(ChatMessage, { message: declineOf("content_policy"), loading: false });
		await expect.element(page.getByRole("button", { name: "Ask for a review" })).toBeVisible();
	});

	it("offers Ask for a review under a child-safety decline too, so a wrong block reaches a person", async () => {
		await render(ChatMessage, { message: declineOf("child_safety"), loading: false });
		await expect.element(page.getByRole("button", { name: "Ask for a review" })).toBeVisible();
	});
});

// The server holds ALIA's untagged reasoning back until its bare `</think>`, so the turn
// would show no text and no reasoning panel meanwhile. The held-reasoning status opens the panel. (CUR-3942)
describe("ChatMessage — reasoning held back by the server (CUR-3942)", () => {
	afterEach(() => {
		cleanup();
	});

	const held = {
		type: MessageUpdateType.Reasoning,
		subtype: MessageReasoningUpdateType.Status,
		status: HELD_REASONING_STATUS,
	} as const;

	it("opens the reasoning panel while the reasoning is held and nothing has streamed", async () => {
		await render(ChatMessage, { message: { ...baseMessage, updates: [held] }, loading: true, isLast: true });
		await expect.element(page.getByTestId("held-reasoning")).toBeInTheDocument();
		await expect.element(page.getByTestId("held-reasoning").getByText("Working…")).toBeInTheDocument();
	});

	it("gives the panel up once the released reasoning and answer arrive", async () => {
		const message: Message = {
			...baseMessage,
			content: "<think>Identify the city.</think>Warsaw.",
			updates: [held],
		};
		await render(ChatMessage, { message, loading: true, isLast: true });
		await expect.element(page.getByText("Warsaw.")).toBeInTheDocument();
		await expect.element(page.getByTestId("held-reasoning")).not.toBeInTheDocument();
	});

	it("shows no held panel on a turn with no held-reasoning status", async () => {
		await render(ChatMessage, { message: { ...baseMessage }, loading: true, isLast: true });
		await expect.element(page.getByTestId("held-reasoning")).not.toBeInTheDocument();
	});
});

// The route check failed and the selected model answered. The note is the answer's own field,
// so a reload shows it; the turn handler's half (streamed, then stored) is server.turn.spec.ts's. (CUR-2830)
describe("ChatMessage — agent-unreachable note (CUR-2830)", () => {
	afterEach(() => {
		cleanup();
	});

	const answered: Message = {
		...baseMessage,
		content: "Three kitchens in Lisbon.",
		updates: [{ type: MessageUpdateType.FinalAnswer, text: "Three kitchens in Lisbon.", interrupted: false }],
	};

	it("says the agent wasn't reachable on an answer the failed route check left to the selected model", async () => {
		await render(ChatMessage, { message: { ...answered, agentRouteFailed: true }, loading: false });
		await expect.element(page.getByText("The agent wasn’t reachable")).toBeInTheDocument();
	});

	it("says nothing about the agent on an ordinary answer", async () => {
		await render(ChatMessage, { message: answered, loading: false });
		await expect.element(page.getByText("Three kitchens in Lisbon.")).toBeInTheDocument();
		await expect.element(page.getByText("The agent wasn’t reachable")).not.toBeInTheDocument();
	});
});

// On a phone Edit and Copy always show (no hover), so they sit below the bubble and must not be
// pinned up into it, over its bottom edge. (CUR-4264)
describe("ChatMessage — Edit and Copy under a sent message (CUR-4264)", () => {
	afterEach(() => {
		cleanup();
	});

	it.each([
		[390, 844],
		[1280, 800]
	])("draws neither button over the bubble at %ipx wide", async (width, height) => {
		await page.viewport(width, height);
		const message: Message = {
			from: "user",
			id: "22222222-2222-4222-8222-222222222222",
			content: "What does Alpha do with what I type here?",
		};
		await render(ChatMessage, { message, loading: false });
		const bubble = page.getByText(message.content).element().getBoundingClientRect();
		for (const name of ["Edit", "Copy"]) {
			const button = page.getByRole("button", { name, exact: true }).element().getBoundingClientRect();
			expect(
				button.top,
				`${name} starts ${bubble.bottom - button.top}px inside the bubble`
			).toBeGreaterThanOrEqual(bubble.bottom);
		}
	});
});
