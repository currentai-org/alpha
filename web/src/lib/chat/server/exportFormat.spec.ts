import { describe, expect, it } from "vitest";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import {
	EXPORT_MAX_BYTES,
	ExportFileError,
	conversationMarkdown,
	exportEnvelope,
	exportedConversation,
	readableName,
	readme,
	validateExportFile,
} from "./exportFormat";

const APERTUS = "swiss-ai/apertus-v1.5-70b";

function conversation(messages: Partial<Message>[], extra: Partial<Conversation> = {}): Conversation {
	return {
		_id: { toString: () => "6ab74dc5692f81f5c150256a" },
		title: "Team FTE count",
		model: APERTUS,
		createdAt: new Date("2026-09-25T10:00:00Z"),
		updatedAt: new Date("2026-09-25T10:05:00Z"),
		messages: messages.map((m, i) => ({ id: `m${i}`, from: "user", content: "", ...m })) as Message[],
		...extra,
	} as unknown as Conversation;
}

// The provenance line an answer carries in the export, read from the JSON copy's own field.
function provenanceLine(message: Partial<Message>, model = APERTUS): string {
	const out = exportedConversation(conversation([{ ...message, from: "assistant" }], { model }));
	return out.messages[0].provenance ?? "";
}

describe("provenance: an answer's source, in the words the chat shows", () => {
	it("names training as the source and the model the badge names", () => {
		const line = provenanceLine({ routerMetadata: { route: "", model: APERTUS } });
		expect(line.split("\n")[0]).toBe("from training · no live sources");
		expect(line.split("\n")[1]).toMatch(/^Apertus .* · .* · host not recorded$/);
		expect(line).not.toContain("backup");
	});

	it("names the host only from the answer's routing record, never a configured one (CUR-3562)", () => {
		const line = provenanceLine({
			routerMetadata: { route: "", model: APERTUS, provider: "together", backend: "https://api.infomaniak.com/1/ai" },
		});
		expect(line.split("\n")[1]).toMatch(/ · served via Together · compute: Infomaniak/);
		expect(line).not.toContain("not recorded");
	});

	it("counts the open sources a looked-up answer cited, with the date it looked", () => {
		const line = provenanceLine({
			routerMetadata: { route: "", model: APERTUS },
			webSearch: {
				query: "q",
				asOf: "2026-09-25T09:00:00Z",
				sources: [
					{ title: "A", url: "https://a" },
					{ title: "B", url: "https://b" },
				],
			},
		} as Partial<Message>);
		expect(line.split("\n")[0]).toBe("looked it up · 2 open sources · as of 2026-09-25");
	});

	it("marks a cross-maker stand-in as the backup, as the badge does", () => {
		const line = provenanceLine({ routerMetadata: { route: "", model: "zai-org/GLM-5.3" } });
		expect(line).toContain("(backup — served in place of the primary model)");
	});

	it("marks a same-maker model that answered after the primary failed as the backup (CUR-2293)", () => {
		const thinking = "swiss-ai/apertus-v1.5-70b-thinking";
		const failed = provenanceLine({
			routerMetadata: { route: "", model: thinking },
			failover: { from: "swiss-ai/apertus-v1.5-70b", to: thinking, reason: "unavailable" },
		} as Partial<Message>);
		expect(failed).toContain("(backup — served in place of the primary model)");
		// The same serve with no failover record is a routing choice, not a stand-in.
		expect(provenanceLine({ routerMetadata: { route: "", model: thinking } })).not.toContain("backup");
	});

	it("judges an answer from before a mid-chat model switch against the model it was asked of, so it is not called a backup (CUR-3234)", () => {
		const large = "mistral-large-2512";
		// The chat was on Large 3 for this answer, then switched to Apertus.
		const line = provenanceLine({ requestedModel: large, routerMetadata: { route: "", model: large } }, APERTUS);
		expect(line).toContain("Mistral");
		expect(line).not.toContain("backup");
		// A real stand-in for that same request is still called one.
		const standIn = provenanceLine({ requestedModel: large, routerMetadata: { route: "", model: "zai-org/GLM-5.3" } }, APERTUS);
		expect(standIn).toContain("(backup — served in place of the primary model)");
	});

	it("says so when nothing reported which model served it, rather than naming one", () => {
		const line = provenanceLine({});
		expect(line).toContain("No provenance for this answer — nothing reported which model served it.");
		expect(line).not.toMatch(/Apertus/);
	});
});

describe("the JSON copy carries named fields, not whole records", () => {
	it("drops the internal fields a whole-record spread used to leak", () => {
		const out = exportedConversation(
			conversation(
				[
					{ from: "system", content: "system prompt" },
					{ from: "user", content: "hi", ancestors: [], children: ["m2"] },
					{
						from: "assistant",
						content: "hello",
						ancestors: ["m1"],
						routerMetadata: { route: "", model: APERTUS, backend: "https://api.featherless.ai/v1" },
						timings: { ttftMs: 1 } as Message["timings"],
						updates: [],
					},
				],
				{ userId: "u", sessionId: "s", userAgent: "ua" } as unknown as Partial<Conversation>
			)
		);
		const text = JSON.stringify(out);
		for (const leaked of ["userId", "sessionId", "userAgent", "timings", "updates", "children", "ancestors", "system prompt"]) {
			expect(text, `the export still carries ${leaked}`).not.toContain(leaked);
		}
		expect(out.messages.map((m) => m.from)).toEqual(["user", "assistant"]);
		expect(out.messages[1]).toMatchObject({
			parentId: "m1",
			servedBy: { model: APERTUS, backend: "Featherless (United States)" },
			provenance: expect.stringContaining("from training"),
		});
	});

	it("names the backend without its URL path, which can carry a provider account id", () => {
		const answer = (backend: string) =>
			exportedConversation(
				conversation([
					{ from: "user", content: "hi", ancestors: [], children: ["m2"] },
					{
						from: "assistant",
						content: "hello",
						ancestors: ["m1"],
						routerMetadata: { route: "", model: APERTUS, backend },
					},
				])
			).messages[1].servedBy;
		expect(answer("https://api.infomaniak.com/2/ai/106744/openai/v1")).toEqual({
			model: APERTUS,
			backend: "Infomaniak (Switzerland)",
		});
		// A backend with no name in the table still loses its path.
		expect(answer("https://llm.example.net/tenant/42/v1")?.backend).toBe("llm.example.net");
	});

	it("names no server for a turn whose record holds only the helpers that ran (CUR-984)", () => {
		const out = exportedConversation(
			conversation([
				{ from: "user", content: "hi", ancestors: [], children: ["m2"] },
				{
					from: "assistant",
					content: "",
					ancestors: ["m1"],
					routerMetadata: { route: "", model: "", assistedBy: [{ role: "search-decision", model: "e" }] },
				},
			])
		);
		expect(out.messages[1]).not.toHaveProperty("servedBy");
	});

	it("marks every answer as AI-generated in IPTC's vocabulary, and never marks what the person wrote (CUR-996)", () => {
		const out = exportedConversation(
			conversation([
				{ from: "user", content: "hi", ancestors: [] },
				{ from: "assistant", content: "hello", ancestors: ["m0"], routerMetadata: { route: "", model: APERTUS } },
				// An answer with no routing record is still model-written.
				{ from: "assistant", content: "again", ancestors: ["m0"] },
			])
		);
		const [user, ...answers] = out.messages;
		for (const answer of answers) {
			expect(answer).toMatchObject({
				aiGenerated: true,
				digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
			});
		}
		expect(user).not.toHaveProperty("aiGenerated");
		expect(user).not.toHaveProperty("digitalSourceType");
		expect(readme({ conversations: 1, files: 0, filesSkipped: 0 })).toContain('"aiGenerated": true');
	});

	it("attaches a file only to the message it belongs to", () => {
		const out = exportedConversation(
			conversation([{ from: "user", content: "a" }, { from: "user", content: "b" }]),
			new Map([["m1", ["attachments/x.txt"]]])
		);
		expect(out.messages[0].files).toBeUndefined();
		expect(out.messages[1].files).toEqual(["attachments/x.txt"]);
	});
});

describe("the readable copy", () => {
	it("follows the branch ending at the latest message, leaving an edited-away turn out", () => {
		const md = conversationMarkdown(
			conversation([
				{ id: "u1", from: "user", content: "first", ancestors: [] },
				{ id: "a1", from: "assistant", content: "old answer", ancestors: ["u1"] },
				{ id: "a2", from: "assistant", content: "new answer", ancestors: ["u1"] },
			])
		);
		expect(md).toContain("first");
		expect(md).toContain("new answer");
		expect(md).not.toContain("old answer");
	});

	it("writes each answer with its provenance quoted under it", () => {
		const md = conversationMarkdown(
			conversation([
				{ id: "u", from: "user", content: "What is 17 × 23?", ancestors: [] },
				{
					id: "a",
					from: "assistant",
					content: "391",
					ancestors: ["u"],
					routerMetadata: { route: "", model: APERTUS },
				},
			])
		);
		expect(md).toContain("# Team FTE count");
		expect(md).toContain("## You\n\nWhat is 17 × 23?");
		expect(md).toContain("## Alpha\n\n391\n\n> from training · no live sources\n> Apertus");
	});

	it("leaves out an agent's step log and an unclosed reasoning block, as the chat does, and keeps them in the JSON copy (CUR-4359)", () => {
		const messages: Partial<Message>[] = [
			{ id: "u", from: "user", content: "Highest mountain in Africa?", ancestors: [] },
			{
				id: "a",
				from: "assistant",
				content: "<think>Working on it via the open agent… Ran 3 step(s).</think>Mount Kilimanjaro.",
				ancestors: ["u"],
			},
			{ id: "u2", from: "user", content: "And in Europe?", ancestors: ["u", "a"] },
			{ id: "a2", from: "assistant", content: "<think>Elbrus or Mont Blanc", ancestors: ["u", "a", "u2"] },
		];
		const md = conversationMarkdown(conversation(messages));
		expect(md).toContain("## Alpha\n\nMount Kilimanjaro.\n");
		expect(md).not.toContain("think>");
		expect(md).not.toContain("Ran 3 step(s)");
		expect(md).not.toContain("Elbrus");
		expect(exportedConversation(conversation(messages)).messages[1].content).toContain("<think>Working on it");
	});

	it("keeps every word of a question about the tag, and of an answer that quotes it (CUR-4359)", () => {
		const md = conversationMarkdown(
			conversation([
				{ id: "u", from: "user", content: "What does the <think> tag do? Also explain caching.", ancestors: [] },
				{
					id: "a",
					from: "assistant",
					content: "Models wrap reasoning in <think> before answering. Caching is separate.",
					ancestors: ["u"],
				},
			])
		);
		expect(md).toContain("What does the <think> tag do? Also explain caching.");
		expect(md).toContain("Models wrap reasoning in <think> before answering. Caching is separate.");
	});

	it("names each attached file's path under the message it came with (CUR-4359)", () => {
		const md = conversationMarkdown(
			conversation([
				{ id: "u", from: "user", content: "What tree is this?", ancestors: [] },
				{ id: "a", from: "assistant", content: "A red maple.", ancestors: ["u"] },
			]),
			new Map([["u", ["files/conversations/abc/123/red-maple.jpg"]]])
		);
		expect(md).toContain("## You\n\nWhat tree is this?\n\nAttached: `files/conversations/abc/123/red-maple.jpg`\n\n## Alpha");
	});

	it("names the file by date, title and a short id", () => {
		expect(readableName(conversation([]))).toBe("conversations/2026-09-25-team-fte-count-c150256a.md");
	});

	it("tells the reader when stored files could not be listed, instead of claiming zero", () => {
		const text = readme({ conversations: 2, files: 0, filesSkipped: 0, listingFailed: true });
		expect(text).toContain("could not be listed");
		expect(text).not.toContain("holds the 0 files");
	});

	it("says there is no files folder when nothing was stored, rather than pointing at a missing one", () => {
		const text = readme({ conversations: 1, files: 0, filesSkipped: 0 });
		expect(text).toContain("no `files/` folder");
		expect(text).not.toContain("holds the 0 files");
	});
});

describe("validateExportFile: an import refuses a file it cannot read before writing anything (CUR-4180)", () => {
	const ACCOUNT = "6ab74dc5692f81f5c1500001";
	const ours = () => exportEnvelope(ACCOUNT, [exportedConversation(conversation([{ content: "hi" }]))]);
	const reason = (text: string, account = ACCOUNT) => {
		try {
			validateExportFile(text, account);
		} catch (error) {
			expect(error).toBeInstanceOf(ExportFileError);
			return (error as ExportFileError).reason;
		}
		return "accepted";
	};

	it("accepts a file this version just exported, for the account that exported it", () => {
		expect(reason(JSON.stringify(ours()))).toBe("accepted");
		expect(validateExportFile(JSON.stringify(ours()), ACCOUNT).conversations[0].title).toBe("Team FTE count");
	});

	it("refuses another product's file, or one with no format at all", () => {
		expect(reason(JSON.stringify({ ...ours(), format: "thunderbolt" }))).toBe("format");
		const { format: _format, ...unnamed } = ours();
		expect(reason(JSON.stringify(unnamed))).toBe("format");
	});

	it("refuses a version it does not know, a missing version, and the bare list older exports wrote", () => {
		expect(reason(JSON.stringify({ ...ours(), schemaVersion: 2 }))).toBe("version");
		const { schemaVersion: _version, ...unversioned } = ours();
		expect(reason(JSON.stringify(unversioned))).toBe("version");
		expect(reason(JSON.stringify(ours().conversations))).toBe("version");
	});

	it("refuses a file exported from a different account", () => {
		expect(reason(JSON.stringify(ours()), "6ab74dc5692f81f5c1500002")).toBe("account");
	});

	it("refuses text that is not JSON, a file with no conversation list, and one over the size cap", () => {
		expect(reason("{not json")).toBe("not-json");
		expect(reason(JSON.stringify({ ...ours(), conversations: "none" }))).toBe("format");
		expect(reason(" ".repeat(EXPORT_MAX_BYTES + 1))).toBe("too-large");
	});
});
