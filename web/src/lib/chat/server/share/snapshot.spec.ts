import { describe, expect, it } from "vitest";
import type { Message } from "$lib/chat/types/Message";
import { buildShareSnapshot, parseShareSnapshot } from "./snapshot";
import { isShareToken, newShareToken } from "./sharedConversations";

// A two-branch tree: root (system) -> u1 -> a1, and u1 was edited into u1b -> a1b.
function tree(): { title: string; model: string; rootMessageId: string; messages: Message[] } {
	const m = (id: string, from: Message["from"], content: string, ancestors: string[], extra: Partial<Message> = {}) =>
		({ id, from, content, ancestors, children: [], ...extra }) as Message;
	return {
		title: "Glaciers <think>x</think>",
		model: "swiss-ai/Apertus-70B",
		rootMessageId: "root",
		messages: [
			m("root", "system", "You are the system message", []),
			m("u1", "user", "How fast do glaciers move?", ["root"], {
				files: [{ type: "hash", name: "private.pdf", value: "abc", mime: "application/pdf" }],
			} as Partial<Message>),
			m("a1", "assistant", "<think>the user wants speed</think>About a metre a day.", ["root", "u1"], {
				reasoning: "private reasoning",
			}),
			m("u1b", "user", "How fast do Alpine glaciers move?", ["root"]),
			m("a1b", "assistant", "Tens of metres a year.", ["root", "u1b"]),
		],
	};
}

describe("share snapshot", () => {
	it("holds the branch the person had open, as text turns only: no system prompt, files or reasoning", () => {
		const snap = buildShareSnapshot(tree(), "a1", new Date("2026-11-06T12:00:00Z"));
		expect(snap.turns).toEqual([
			{ from: "user", content: "How fast do glaciers move?" },
			{ from: "assistant", content: "About a metre a day." },
		]);
		expect(snap.title).toBe("Glaciers x");
		expect(snap.sharedAt).toBe("2026-11-06T12:00:00.000Z");
		const stored = JSON.stringify(snap);
		expect(stored).not.toContain("the system message");
		expect(stored).not.toContain("private.pdf");
		expect(stored).not.toContain("private reasoning");
		expect(stored).not.toContain("the user wants speed");
	});

	it("falls back to the newest message when the leaf is missing or names nothing here", () => {
		for (const leaf of [undefined, "not-a-message"]) {
			expect(buildShareSnapshot(tree(), leaf).turns.map((t) => t.content)).toEqual([
				"How fast do Alpine glaciers move?",
				"Tens of metres a year.",
			]);
		}
	});

	it("shares an empty conversation as no turns rather than throwing", () => {
		expect(buildShareSnapshot({ title: "", model: "m", messages: [] }, undefined).turns).toEqual([]);
	});

	it("reads back only a snapshot shape it knows, and drops a turn of any other role", () => {
		expect(parseShareSnapshot(null)).toBeNull();
		expect(parseShareSnapshot({ v: 2, turns: [] })).toBeNull();
		const parsed = parseShareSnapshot({
			v: 1,
			title: "t",
			model: "m",
			sharedAt: "x",
			turns: [
				{ from: "user", content: "hi" },
				{ from: "system", content: "system text" },
			],
		});
		expect(parsed?.turns).toEqual([{ from: "user", content: "hi" }]);
	});
});

describe("share tokens", () => {
	it("are at least 128 random bits, base64url, and never repeat across a thousand draws", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			const t = newShareToken();
			expect(t).toMatch(/^[A-Za-z0-9_-]{24}$/);
			expect(Buffer.from(t, "base64url").length * 8).toBeGreaterThanOrEqual(128);
			seen.add(t);
		}
		expect(seen.size).toBe(1000);
	});

	it("accepts our tokens and an imported Open WebUI uuid, and refuses anything shorter or odd before a query", () => {
		expect(isShareToken(newShareToken())).toBe(true);
		expect(isShareToken("0b5c1f0e-6a52-4f0e-9a7d-3c1e5b2a9f10")).toBe(true);
		expect(isShareToken("abc1234")).toBe(false);
		expect(isShareToken("../../etc/passwd-aaaaaaaaaaaaaaaa")).toBe(false);
	});
});
