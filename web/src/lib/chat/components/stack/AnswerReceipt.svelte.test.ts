import AnswerReceipt from "./AnswerReceipt.svelte";
import { render, cleanup } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, expect, it, afterEach } from "vitest";
import type { Message } from "$lib/chat/types/Message";
import { MessageUpdateStatus, MessageUpdateType } from "$lib/chat/types/MessageUpdate";

// The receipt's "Looked up" line said a search ran and found nothing whenever a
// `searchAttempt` was recorded, including when the decider chose not to search at all
// (`searched: false`), so X-ray misstated what happened. Step by step already split the two. (CUR-2657)
const answer = (extra: Partial<Message> = {}): Message =>
	({
		id: "m1",
		from: "assistant",
		content: "An answer.",
		...extra,
	}) as Message;

const lookedUp = () => page.getByText(/answered from what the model already knows/i);

describe("AnswerReceipt — the Looked up line tells a declined search from an empty one (CUR-2657)", () => {
	afterEach(() => {
		cleanup();
	});

	it("says a search was decided against, never that one ran, when the decider declined (searched: false)", async () => {
		await render(AnswerReceipt, {
			message: answer({ searchAttempt: { grounded: false, searched: false } }),
			conversationModelId: "m",
		});
		await expect.element(lookedUp()).toHaveTextContent(/decided a web search wasn.t needed/i);
		await expect.element(lookedUp()).not.toHaveTextContent(/searched the web/i);
	});

	it("says the search ran and found nothing reliable when it ran with no usable sources (searched: true)", async () => {
		await render(AnswerReceipt, {
			message: answer({ searchAttempt: { grounded: false, searched: true } }),
			conversationModelId: "m",
		});
		await expect
			.element(lookedUp())
			.toHaveTextContent(/searched the web but found nothing reliable enough to use/i);
	});

	it("says nothing was looked up when no search was considered at all", async () => {
		await render(AnswerReceipt, { message: answer(), conversationModelId: "m" });
		await expect.element(lookedUp()).toHaveTextContent(/nothing was looked up/i);
	});
});

// A send the server failed leaves an empty assistant turn ending in an error status. The
// receipt described it as an answer from the model's own knowledge. (CUR-2812)
describe("AnswerReceipt — a turn that failed before any answer says so (CUR-2812)", () => {
	afterEach(() => {
		cleanup();
	});

	const failed = (content: string) =>
		answer({
			content,
			updates: [
				{
					type: MessageUpdateType.Status,
					status: MessageUpdateStatus.Error,
					message: "The connection dropped before a reply arrived. Please try again.",
				},
			],
		} as Partial<Message>);

	it("says the turn failed and claims no lookup or model when it ended in an error with no text", async () => {
		await render(AnswerReceipt, { message: failed(""), conversationModelId: "m" });
		await expect
			.element(page.getByText(/failed before any answer arrived/i))
			.toBeInTheDocument();
		await expect.element(lookedUp()).not.toBeInTheDocument();
	});

	it("still describes the answer when an error ended a turn that had already written text", async () => {
		await render(AnswerReceipt, { message: failed("Half an answer"), conversationModelId: "m" });
		await expect.element(lookedUp()).toBeInTheDocument();
	});
});

// read-aloud records itself as an open tool, so the receipt said "Used tools to work on your
// request" about an answer Step by step said looked nothing up. (CUR-3317)
describe("AnswerReceipt — Read aloud is not a lookup (CUR-3317)", () => {
	afterEach(() => {
		cleanup();
	});

	it("says nothing was looked up when the only tool was read-aloud", async () => {
		await render(AnswerReceipt, {
			message: answer({ mcp: { tool: "read_aloud", args: { text: "An answer." }, result: "/chat/api/speech/x.mp3" } } as Partial<Message>),
			conversationModelId: "m",
		});
		await expect.element(lookedUp()).toHaveTextContent(/nothing was looked up/i);
		await expect.element(page.getByText(/used tools to work on your request/i)).not.toBeInTheDocument();
	});

	it("still says tools were used when an open tool other than read-aloud ran", async () => {
		await render(AnswerReceipt, {
			message: answer({ mcp: { tool: "image_search", args: {}, result: "ok" } } as Partial<Message>),
			conversationModelId: "m",
		});
		await expect.element(page.getByText(/used tools to work on your request/i)).toBeInTheDocument();
	});
});

// A turn answered from an MCP tool (an operator's server or the person's own) read "nothing
// was looked up" on X-ray's default tab, though Step by step named the call. (CUR-4038)
describe("AnswerReceipt — never says nothing was looked up when an MCP tool answered (CUR-4038)", () => {
	const mcpCalls = [{ server: "deepwiki", tool: "ask_wiki_question", outcome: "ok", ms: 19262 }];

	it("names the server and tool a call ran on", async () => {
		await render(AnswerReceipt, { message: answer({ mcpCalls }), conversationModelId: "m" });
		await expect
			.element(page.getByText("ask_wiki_question on deepwiki: it ran, and the answer used its result."))
			.toBeInTheDocument();
		await expect.element(page.getByText(/nothing was looked up/i)).not.toBeInTheDocument();
	});

	it("says a declined call did not run, and lists each of two calls to the same tool", async () => {
		await render(AnswerReceipt, {
			message: answer({ mcpCalls: [...mcpCalls, { ...mcpCalls[0], outcome: "declined" }, ...mcpCalls] }),
			conversationModelId: "m",
		});
		await expect.element(page.getByText(/ask_wiki_question on deepwiki: you said no/i)).toBeInTheDocument();
		await expect.poll(() => page.getByText(/ask_wiki_question on deepwiki: it ran/i).all().length).toBe(2);
	});
});

// An answer read from a file the visitor attached, with no search, said "nothing was looked
// up", so X-ray hid the one source the answer came from. (CUR-4150)
describe("AnswerReceipt — a file the visitor attached counts as looked up (CUR-4150)", () => {
	afterEach(() => {
		cleanup();
	});

	it("names the attached file under Looked up and never says nothing was looked up", async () => {
		await render(AnswerReceipt, {
			message: answer(),
			conversationModelId: "m",
			attachedFiles: ["lakeside-notes.txt"],
		});
		await expect.element(page.getByText("Read the file you attached: lakeside-notes.txt.")).toBeVisible();
		await expect.element(page.getByText(/nothing was looked up/i)).not.toBeInTheDocument();
	});

	it("names each file when the question carried two", async () => {
		await render(AnswerReceipt, {
			message: answer(),
			conversationModelId: "m",
			attachedFiles: ["a.txt", "b.pdf"],
		});
		await expect.element(page.getByText("Read the file you attached: a.txt.")).toBeVisible();
		await expect.element(page.getByText("Read the file you attached: b.pdf.")).toBeVisible();
	});
});
