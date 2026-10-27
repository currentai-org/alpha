import { describe, it, expect, vi } from "vitest";
import type { Message } from "$lib/chat/types/Message";
import { settlePendingAnswers } from "./settlePendingAnswers";

const msg = (m: Partial<Message> & Pick<Message, "id" | "from">): Message =>
	({ content: "", createdAt: new Date(), updatedAt: new Date(), ...m }) as Message;

const question = msg({ id: "q", from: "user", content: "Tell me about river trade." });
const stopped = msg({ id: "a1", from: "assistant", content: "River trade was", interrupted: true });
const placeholder = msg({ id: "a1", from: "assistant" });

describe("which answers count as unsaved", () => {
	const askedAbout = async (messages: Message[]) => {
		const inFlight = vi.fn().mockResolvedValue(false);
		await settlePendingAnswers({ messages, inFlight, reload: vi.fn() });
		return inFlight.mock.calls[0]?.[0];
	};
	it("an assistant answer with no text and no updates", async () => {
		expect(await askedAbout([question, placeholder])).toEqual(["a1"]);
	});
	it("not a saved answer, a user message, or an empty answer that carries updates", async () => {
		const errored = msg({
			id: "a2",
			from: "assistant",
			updates: [{ type: "status", status: "error" }] as unknown as Message["updates"],
		});
		expect(await askedAbout([question, stopped, errored])).toBeUndefined();
	});
});

describe("settlePendingAnswers", () => {
	const noSleep = () => Promise.resolve();

	it("returns a fresh load (not the stale one) once the in-flight answer's turn has saved", async () => {
		const inFlight = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
		const reload = vi.fn().mockResolvedValue({ messages: [question, stopped] });
		const res = await settlePendingAnswers({ messages: [question, placeholder], inFlight, reload, sleep: noSleep });
		expect(res).toEqual({ messages: [question, stopped] });
		expect(inFlight).toHaveBeenCalledWith(["a1"]);
		expect(inFlight).toHaveBeenCalledTimes(3);
		expect(reload).toHaveBeenCalledOnce();
	});

	it("queries nothing and returns null when no answer is unsaved", async () => {
		const inFlight = vi.fn();
		const reload = vi.fn();
		expect(await settlePendingAnswers({ messages: [question, stopped], inFlight, reload })).toBeNull();
		expect(inFlight).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	it("returns null without reloading when the unsaved answer's turn is not in flight", async () => {
		const reload = vi.fn();
		const res = await settlePendingAnswers({
			messages: [question, placeholder],
			inFlight: () => Promise.resolve(false),
			reload,
		});
		expect(res).toBeNull();
		expect(reload).not.toHaveBeenCalled();
	});

	it("stops waiting at the cap when a generation stays in flight, then reloads anyway", async () => {
		const reload = vi.fn().mockResolvedValue("fresh");
		const start = Date.now();
		const res = await settlePendingAnswers({
			messages: [question, placeholder],
			inFlight: () => Promise.resolve(true),
			reload,
			timeoutMs: 60,
			intervalMs: 10,
		});
		expect(res).toBe("fresh");
		expect(Date.now() - start).toBeLessThan(1000);
	});
});
