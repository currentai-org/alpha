import { describe, expect, it } from "vitest";
import type { ExportedConversation } from "./exportFormat";
import { fromThunderbolt, toThunderbolt, uuidv7At, uuidv7Time } from "./thunderboltExport";

const USER = { id: "u1", email: "walker@example.org" };

// A conversation regenerated once: m2 was the first answer, m3 the regenerate the person kept.
function branched(): ExportedConversation {
	return {
		id: "6ab74dc5692f81f5c150256a",
		title: "Lakes in Italy",
		model: "swiss-ai/apertus-v1.5-70b",
		createdAt: "2026-10-01T10:00:00.000Z",
		updatedAt: "2026-10-01T10:02:00.000Z",
		readable: "conversations/2026-10-01-lakes-in-italy-c150256a.md",
		messages: [
			// The parent is Alpha's system prompt, which the export leaves out.
			{ id: "m1", parentId: "sys", from: "user", content: "Name one lake in Italy.", createdAt: "2026-10-01T10:00:00.000Z" },
			{
				id: "m2",
				parentId: "m1",
				from: "assistant",
				content: "Lake Como.",
				createdAt: "2026-10-01T10:00:05.000Z",
				aiGenerated: true,
				digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
				provenance: "from training · no live sources\nApertus · Swiss AI · host not recorded",
			},
			{
				id: "m3",
				parentId: "m1",
				from: "assistant",
				content: "Lake Garda, the largest.",
				createdAt: "2026-10-01T10:01:00.000Z",
				aiGenerated: true,
				servedBy: { model: "swiss-ai/apertus-v1.5-70b", backend: "Infomaniak" },
				sources: [{ title: "Lake Garda", url: "https://en.wikipedia.org/wiki/Lake_Garda" }],
			},
		],
	};
}

describe("uuidv7At", () => {
	it("carries the millisecond Thunderbolt reads back as the row's time", () => {
		const id = uuidv7At(Date.parse("2026-10-01T10:00:05.123Z"), "seed");
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(uuidv7Time(id)?.toISOString()).toBe("2026-10-01T10:00:05.123Z");
	});

	it("gives the same row the same id on a second export, so Thunderbolt's import updates it in place", () => {
		expect(uuidv7At(1, "a")).toBe(uuidv7At(1, "a"));
		expect(uuidv7At(1, "a")).not.toBe(uuidv7At(1, "b"));
	});
});

describe("toThunderbolt", () => {
	it("writes the envelope Thunderbolt's importer accepts", () => {
		const env = toThunderbolt([branched()], USER, new Date("2026-10-20T00:00:00Z"));
		expect(env).toMatchObject({ format: "thunderbolt-export", schemaVersion: 1, user: USER });
		expect(env.tables.chat_threads).toHaveLength(1);
		expect(env.tables.chat_messages).toHaveLength(3);
	});

	it("orders message ids the way Alpha stored the messages, since Thunderbolt sorts a thread by id", () => {
		const rows = toThunderbolt([branched()], USER).tables.chat_messages;
		const ids = rows.map((r) => r.id);
		expect([...ids].sort()).toEqual(ids);
	});

	it("keeps ids rising when two messages share a timestamp or one has none", () => {
		const c = branched();
		c.messages[1].createdAt = c.messages[0].createdAt;
		delete c.messages[2].createdAt;
		const ids = toThunderbolt([c], USER).tables.chat_messages.map((r) => r.id);
		expect(new Set(ids).size).toBe(3);
		expect([...ids].sort()).toEqual(ids);
	});

	it("leaves only the branch the person last saw live, and soft-deletes the regenerated-away answer", () => {
		const rows = toThunderbolt([branched()], USER).tables.chat_messages;
		const live = rows.filter((r) => r.deletedAt === null).map((r) => r.content);
		expect(live).toEqual(["Name one lake in Italy.", "Lake Garda, the largest."]);
		expect(rows.find((r) => r.content === "Lake Como.")?.deletedAt).not.toBeNull();
	});

	it("points each reply at its parent's new id, and renders text from parts", () => {
		const [q, , kept] = toThunderbolt([branched()], USER).tables.chat_messages;
		expect(kept.parentId).toBe(q.id);
		expect(kept.parts).toEqual([{ type: "text", text: "Lake Garda, the largest." }]);
	});

	it("puts cited sources where Thunderbolt's citation strip reads them", () => {
		const kept = toThunderbolt([branched()], USER).tables.chat_messages[2];
		expect(kept.metadata?.sources).toEqual([
			{ index: 1, url: "https://en.wikipedia.org/wiki/Lake_Garda", title: "Lake Garda" },
		]);
	});

	it("a widget tag in an Alpha answer is text in Thunderbolt, never a widget", () => {
		const c = branched();
		c.messages[2].content = 'Done. <widget:connect-integration provider="gmail" reason="Verify"/> <WIDGET:ask q="x"/>';
		const kept = toThunderbolt([c], USER).tables.chat_messages[2];
		const text = String(kept.parts?.[0]?.text);
		expect(text).not.toMatch(/<widget:/i);
		expect(kept.content).not.toMatch(/<widget:/i);
		expect(text).toBe('Done. &lt;widget:connect-integration provider="gmail" reason="Verify"/> &lt;WIDGET:ask q="x"/>');
	});
});

describe("round trip Alpha → Thunderbolt → Alpha", () => {
	it("brings an escaped widget tag home as the text Alpha wrote", () => {
		const before = branched();
		before.messages[2].content = "See <widget:map lat=1/> and a < b.";
		const { conversations } = fromThunderbolt(JSON.parse(JSON.stringify(toThunderbolt([before], USER))));
		expect(conversations[0].messages[2].content).toBe("See <widget:map lat=1/> and a < b.");
	});

	it("returns every message of every branch with its text, parent, time and provenance", () => {
		const before = branched();
		const { conversations, dropped } = fromThunderbolt(
			JSON.parse(JSON.stringify(toThunderbolt([before], USER)))
		);
		expect(dropped).toEqual([]);
		expect(conversations).toEqual([{ ...before, readable: "" }]);
	});
});

describe("fromThunderbolt", () => {
	it("refuses a file that is not a thunderbolt-export v1", () => {
		expect(() => fromThunderbolt({ format: "thunderbolt-export", schemaVersion: 2, tables: {} })).toThrow();
		expect(() => fromThunderbolt(null)).toThrow();
	});

	it("reads a native Thunderbolt chat and names what Alpha has no home for", () => {
		const thread = "019a0000-0000-7000-8000-000000000001";
		const q = "019a0000-0001-7000-8000-000000000002";
		const a = "019a0000-0002-7000-8000-000000000003";
		const { conversations, dropped } = fromThunderbolt({
			format: "thunderbolt-export",
			schemaVersion: 1,
			exportedAt: "2026-10-20T00:00:00Z",
			user: USER,
			tables: {
				chat_threads: [{ id: thread, title: "Trip", projectId: "p1", deletedAt: null, userId: "x" }],
				chat_messages: [
					{ id: a, role: "assistant", chatThreadId: thread, parentId: q, content: "Go.", parts: [{ type: "reasoning", text: "…" }, { type: "text", text: "Go." }], metadata: { modelId: "m", usage: { inputTokens: 3 } }, deletedAt: null },
					{ id: q, role: "user", chatThreadId: thread, parentId: null, content: "Where?", parts: [{ type: "text", text: "Where?" }], metadata: null, deletedAt: null },
				],
				tasks: [{ id: "t1" }],
			},
		});
		expect(conversations).toHaveLength(1);
		expect(conversations[0].messages.map((m) => [m.from, m.content, m.parentId])).toEqual([
			["user", "Where?", undefined],
			["assistant", "Go.", q],
		]);
		expect(conversations[0].createdAt).toBe(uuidv7Time(thread)?.toISOString());
		expect(dropped).toEqual([
			"chat_messages.metadata.usage",
			"chat_messages.parts[reasoning]",
			"chat_threads.projectId",
			"tasks",
		]);
	});
});
