import { describe, expect, it } from "vitest";
import type { Message } from "$lib/chat/types/Message";
import { MessageUpdateType } from "$lib/chat/types/MessageUpdate";
import { mergeMessages, snapshotConversation } from "./conversationWrites";

const msg = (id: string, from: Message["from"], ancestors: string[], extra: Partial<Message> = {}): Message => ({
	id,
	from,
	content: "",
	ancestors,
	children: [],
	...extra,
});

/** root → q1 → a1, the conversation both requests loaded. */
function loaded(): Message[] {
	return [
		msg("root", "system", [], { children: ["q1"] }),
		msg("q1", "user", ["root"], { content: "first question", children: ["a1"] }),
		msg("a1", "assistant", ["root", "q1"], { content: "first answer" }),
	];
}

/** What a turn appending `q` → `a` under a1 makes of `messages`. */
function withTurn(messages: Message[], q: string, a: string, answer = ""): Message[] {
	return [
		...messages.map((m) => (m.id === "a1" ? { ...m, children: [...(m.children ?? []), q] } : m)),
		msg(q, "user", ["root", "q1", "a1"], { content: `${q} asks`, children: [a] }),
		msg(a, "assistant", ["root", "q1", "a1", q], { content: answer }),
	];
}

const ids = (messages: Message[]) => messages.map((m) => m.id);
const byId = (messages: Message[], id: string) => messages.find((m) => m.id === id);

describe("mergeMessages keeps every writer's messages", () => {
	it("keeps the other tab's turn when two turns append under the same answer", () => {
		const base = snapshotConversation({ messages: loaded(), title: "t" }).messages;
		const stored = withTurn(loaded(), "qB", "aB", "B's answer");
		const merged = mergeMessages(base, withTurn(loaded(), "qA", "aA", "A's answer"), stored);

		expect(ids(merged)).toEqual(["root", "q1", "a1", "qB", "aB", "qA", "aA"]);
		expect(byId(merged, "a1")?.children).toEqual(["qB", "qA"]);
		expect(byId(merged, "aB")?.content).toBe("B's answer");
		expect(byId(merged, "aA")?.content).toBe("A's answer");
	});

	it("keeps an answer another request finished, when this request only built on its empty placeholder", () => {
		// Retry right after Stop (CUR-2667): the retry loaded the stopped answer before its final save.
		const placeholder = withTurn(loaded(), "q2", "a2");
		const base = snapshotConversation({ messages: placeholder, title: "t" }).messages;
		const stored = placeholder.map((m) => (m.id === "a2" ? { ...m, content: "the stopped text" } : m));
		const merged = mergeMessages(base, placeholder, stored);

		expect(byId(merged, "a2")?.content).toBe("the stopped text");
	});

	it("writes this request's own later save over its own earlier one", () => {
		const base = snapshotConversation({ messages: loaded(), title: "t" }).messages;
		const firstSave = mergeMessages(base, withTurn(loaded(), "qA", "aA"), loaded());
		const finalSave = mergeMessages(base, withTurn(loaded(), "qA", "aA", "done"), firstSave);

		expect(ids(finalSave)).toEqual(["root", "q1", "a1", "qA", "aA"]);
		expect(byId(finalSave, "aA")?.content).toBe("done");
		expect(byId(finalSave, "a1")?.children).toEqual(["qA"]);
	});

	it("is a no-op when this request changed nothing, whatever is stored now", () => {
		const base = snapshotConversation({ messages: loaded(), title: "t" }).messages;
		const stored = withTurn(loaded(), "qB", "aB", "B's answer");

		expect(mergeMessages(base, loaded(), stored)).toEqual(stored);
	});

	it("treats a message rebuilt with its keys in another order as unchanged", () => {
		const base = snapshotConversation({ messages: loaded(), title: "t" }).messages;
		const reordered = loaded().map((m) => Object.fromEntries(Object.entries(m).reverse()) as Message);
		const stored = loaded().map((m) => (m.id === "a1" ? { ...m, content: "edited elsewhere" } : m));

		expect(byId(mergeMessages(base, reordered, stored), "a1")?.content).toBe("edited elsewhere");
	});
});

describe("mergeMessages and two re-attaches to one agent run (CUR-3875)", () => {
	const agentRun = { taskId: "t1" };
	const ending = (text: string, interrupted?: boolean) => [
		{ type: MessageUpdateType.FinalAnswer, text, ...(interrupted ? { interrupted } : {}) },
	] as Message["updates"];
	/** The answer as each attach's prestream save leaves it: emptied, to be rebuilt from the run's events. */
	const emptied = () =>
		loaded().map((m) => (m.id === "a1" ? { ...m, content: "", updates: [], interrupted: false, agentRun } : m));

	it("an older attach cut off by its deadline does not overwrite the answer a newer attach finished", () => {
		const olderBase = snapshotConversation({ messages: emptied(), title: "t" }).messages;
		const finished = emptied().map((m) =>
			m.id === "a1" ? { ...m, content: "All ten paragraphs.", updates: ending("All ten paragraphs.") } : m
		);
		const cutOff = emptied().map((m) =>
			m.id === "a1"
				? { ...m, content: "Five paragraphs.", updates: ending("Five paragraphs.", true), interrupted: true }
				: m
		);
		const merged = mergeMessages(olderBase, cutOff, finished);
		expect(byId(merged, "a1")?.content).toBe("All ten paragraphs.");
		expect(byId(merged, "a1")?.interrupted).toBe(false);
	});

	it("a newer attach's finished answer still replaces the older one's interrupted save", () => {
		const newerBase = snapshotConversation({ messages: emptied(), title: "t" }).messages;
		const cutOff = emptied().map((m) =>
			m.id === "a1"
				? { ...m, content: "Five paragraphs.", updates: ending("Five paragraphs.", true), interrupted: true }
				: m
		);
		const finished = emptied().map((m) =>
			m.id === "a1" ? { ...m, content: "All ten paragraphs.", updates: ending("All ten paragraphs.") } : m
		);
		expect(byId(mergeMessages(newerBase, finished, cutOff), "a1")?.content).toBe("All ten paragraphs.");
	});

	it("an attach begun after the run finished does not empty the stored answer while it replays", () => {
		const finished = emptied().map((m) =>
			m.id === "a1" ? { ...m, content: "All ten paragraphs.", updates: ending("All ten paragraphs.") } : m
		);
		const lateBase = snapshotConversation({ messages: finished, title: "t" }).messages;
		const merged = mergeMessages(lateBase, emptied(), finished);
		expect(byId(merged, "a1")?.content).toBe("All ten paragraphs.");
	});
});

describe("mergeMessages removes only what nobody else touched", () => {
	/** What deleting `id` and everything below it makes of `messages`, as the delete endpoints do. */
	const without = (messages: Message[], id: string) =>
		messages
			.filter((m) => m.id !== id && !m.ancestors?.includes(id))
			.map((m) => ({ ...m, children: m.children?.filter((c) => c !== id) }));

	it("removes a message and unlinks it from its parent", () => {
		const start = withTurn(loaded(), "q2", "a2", "two");
		const base = snapshotConversation({ messages: start, title: "t" }).messages;
		const merged = mergeMessages(base, without(start, "q2"), start);

		expect(ids(merged)).toEqual(["root", "q1", "a1"]);
		expect(byId(merged, "a1")?.children).toEqual([]);
	});

	it("keeps a removed message that another request changed since", () => {
		const start = withTurn(loaded(), "q2", "a2");
		const base = snapshotConversation({ messages: start, title: "t" }).messages;
		const stored = start.map((m) => (m.id === "a2" ? { ...m, content: "finished elsewhere" } : m));
		const merged = mergeMessages(base, without(start, "a2"), stored);

		expect(byId(merged, "a2")?.content).toBe("finished elsewhere");
	});

	it("keeps a removed message that a turn added since now hangs below", () => {
		const start = withTurn(loaded(), "q2", "a2", "two");
		const base = snapshotConversation({ messages: start, title: "t" }).messages;
		const stored = [
			...start.map((m) => (m.id === "a2" ? { ...m, children: ["q3"] } : m)),
			msg("q3", "user", ["root", "q1", "a1", "q2", "a2"], { content: "three" }),
		];
		const merged = mergeMessages(base, without(start, "q2"), stored);

		expect(ids(merged)).toContain("q3");
		expect(ids(merged)).toContain("q2");
		expect(byId(merged, "a1")?.children).toEqual(["q2"]);
	});
});
