import { describe, it, expect } from "vitest";
import { conversationToMarkdown, exportFilename } from "./exportConversation";
import type { Message } from "$lib/chat/types/Message";

const msg = (from: Message["from"], content: string, extra: Partial<Message> = {}): Message =>
	({ from, content, id: "x", ...extra }) as Message;

const fixedDate = new Date(2026, 5, 20); // 2026-06-20 (local)

describe("conversationToMarkdown", () => {
	it("renders user + assistant turns with frontmatter and title", () => {
		const md = conversationToMarkdown({
			title: "EU AI Act status",
			model: "Apertus 70B",
			exportedAt: fixedDate,
			messages: [msg("user", "What is the EU AI Act?"), msg("assistant", "It is a regulation.")],
		});
		expect(md).toContain("---");
		expect(md).toContain('title: "EU AI Act status"');
		expect(md).toContain('model: "Apertus 70B"');
		expect(md).toContain("exported: 2026-06-20");
		expect(md).toContain("# EU AI Act status");
		expect(md).toContain("## You");
		expect(md).toContain("What is the EU AI Act?");
		expect(md).toContain("## Assistant");
		expect(md).toContain("It is a regulation.");
	});

	it("NEVER exports system / persona turns", () => {
		const md = conversationToMarkdown({
			messages: [
				msg("system", "You are a machine. Persona secret sauce."),
				msg("user", "hi"),
				msg("assistant", "hello"),
			],
		});
		expect(md).not.toContain("Persona secret sauce");
		expect(md).not.toContain("## System");
	});

	it("includes cited open-web sources with dates", () => {
		const md = conversationToMarkdown({
			messages: [
				msg("user", "current status?"),
				msg("assistant", "In force since 2024 [1].", {
					webSearch: {
						query: "eu ai act",
						asOf: "2026-06-20T00:00:00.000Z",
						sources: [
							{
								n: 1,
								title: "EU AI Act",
								url: "https://example.org/act",
								snippet: "…",
								engine: "Wikipedia",
								asOf: "2026-06-19T12:00:00Z",
							},
						],
					},
				}),
			],
		});
		expect(md).toContain("**Sources**");
		expect(md).toContain("- [1] EU AI Act (2026-06-19) — https://example.org/act");
	});

	it("renders the persisted GLOBAL citation numbers for web + RAG (no double-offset)", () => {
		// Post-merge, RagSource.n is already global: a turn with 1 web source [1] persists its RAG
		// source as n=2. The export must render that n directly — exactly like the on-screen strips
		// — not add webSources.length again (which would print [3] and desync from the answer body).
		const md = conversationToMarkdown({
			messages: [
				msg("assistant", "See [1] and [2].", {
					webSearch: {
						query: "q",
						asOf: "2026-06-20T00:00:00.000Z",
						sources: [
							{
								n: 1,
								title: "Web hit",
								url: "https://example.org/web",
								snippet: "…",
								engine: "Wikipedia",
							},
						],
					},
					rag: {
						query: "cloud compute",
						asOf: "2026-06-20T00:00:00.000Z",
						sources: [
							{
								n: 2,
								title: "Cloud Compute",
								url: "https://github.com/org/repo",
								snippet: "GPU.",
								engine: "Potluck",
							},
						],
					},
				}),
			],
		});
		expect(md).toContain("- [1] Web hit — https://example.org/web");
		expect(md).toContain("- [2] Cloud Compute (2026-06-20) — https://github.com/org/repo");
	});

	it("renders an admin community RAG source by its global n", () => {
		const md = conversationToMarkdown({
			messages: [
				msg("assistant", "Per [1].", {
					rag: {
						query: "inference",
						asOf: "2026-06-20T00:00:00.000Z",
						sources: [
							{
								n: 1,
								title: "Community note",
								url: "https://example.org/note",
								snippet: "…",
								engine: "Potluck:Community",
							},
						],
					},
				}),
			],
		});
		expect(md).toContain("- [1] Community note (2026-06-20) — https://example.org/note");
	});

	it("includes vault synthesis as a separate attributed block", () => {
		const md = conversationToMarkdown({
			messages: [
				msg("assistant", "Chaplin lived in Vevey.", {
					rag: {
						query: "personality in Vaud",
						asOf: "2026-06-20T00:00:00.000Z",
						sources: [],
						vaultSynthesis: "Charlie Chaplin lived in Vevey.",
					},
				}),
			],
		});
		expect(md).toContain("**Federated synthesis (local-culture vault)**");
		expect(md).toContain("Charlie Chaplin lived in Vevey.");
	});

	it("skips empty turns and collapses excess blank lines", () => {
		const md = conversationToMarkdown({
			title: "t",
			messages: [msg("assistant", "   "), msg("user", "real")],
		});
		expect(md).not.toMatch(/\n{3,}/);
		expect(md).toContain("real");
		expect(md.endsWith("\n")).toBe(true);
	});

	it("defaults an untitled conversation", () => {
		const md = conversationToMarkdown({ messages: [msg("user", "x")] });
		expect(md).toContain("# Untitled conversation");
	});
});

describe("exportFilename", () => {
	it("slugifies the title with a date prefix/suffix", () => {
		expect(exportFilename("EU AI Act: Status!", fixedDate)).toBe(
			"aipotluck.org-eu-ai-act-status-2026-06-20.md"
		);
	});
	it("falls back for an empty/untitled conversation", () => {
		expect(exportFilename("", fixedDate)).toBe("aipotluck.org-conversation-2026-06-20.md");
		expect(exportFilename(undefined, fixedDate)).toBe("aipotluck.org-conversation-2026-06-20.md");
	});
	it("caps very long titles", () => {
		const name = exportFilename("a".repeat(200), fixedDate);
		expect(name.length).toBeLessThan(90);
	});
});
