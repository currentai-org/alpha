/**
 * The parts of conversation sync that need no database. The gate's order (401, 403, then the
 * flag's 404), CORS answering only a registered origin, the push schema accepting id-only deletes,
 * and the sign-in bridge's rebuilt authorize URL. (CUR-4312)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "bson";

const { flag } = vi.hoisted(() => ({ flag: { on: false } }));
vi.mock("$lib/chat/server/dataPortability", async (orig) => ({
	...(await orig<typeof import("$lib/chat/server/dataPortability")>()),
	thunderboltSyncEnabled: () => flag.on,
}));

import { syncGate } from "./syncGate";
import { applySyncCors, isSyncCorsPath, syncCorsHeaders, syncPreflight } from "./syncCors";
import { authorizeResumePath } from "./authorizeResume";
import { decodeCursor, encodeCursor, liveBranch, pushBodySchema, toConversationV1 } from "./syncWire";
import { removeMessage, syncedMessage } from "./syncPush";
import { isConversationGenerationActive } from "$lib/chat/utils/generationState";
import type { Message } from "$lib/chat/types/Message";

const SANDBOX = "https://thunderbolt.example.org";
const user = { _id: new ObjectId() } as NonNullable<App.Locals["user"]>;
const locals = (sync: App.Locals["sync"], signedIn = true) =>
	({ sessionId: "s", isAdmin: false, user: signedIn ? user : undefined, sync }) as App.Locals;

describe("syncGate", () => {
	beforeEach(() => {
		flag.on = false;
	});

	it("flag off → 404 for a caller holding a valid sync token", async () => {
		const res = syncGate(locals({ clientId: "thunderbolt-sandbox" }));
		expect(res).toBeInstanceOf(Response);
		expect((res as Response).status).toBe(404);
	});

	it("flag on → the caller, with the client the token was minted for", () => {
		flag.on = true;
		expect(syncGate(locals({ clientId: "thunderbolt-sandbox" }))).toEqual({ user, clientId: "thunderbolt-sandbox" });
	});

	it("refuses before reading the flag: no token 401, a token without the scope 403", () => {
		flag.on = true;
		expect((syncGate(locals(undefined, false)) as Response).status).toBe(401);
		expect((syncGate(locals({ error: "unauthenticated" }, false)) as Response).status).toBe(401);
		expect((syncGate(locals({ error: "not_permitted" }, false)) as Response).status).toBe(403);
	});

	it("a session cookie alone (a signed-in user, no sync token) is a 401, never the user", () => {
		flag.on = true;
		expect((syncGate(locals(undefined)) as Response).status).toBe(401);
	});
});

describe("sync CORS", () => {
	it("answers the registered origin by name, without credentials", () => {
		const h = syncCorsHeaders(SANDBOX);
		expect(h["Access-Control-Allow-Origin"]).toBe(SANDBOX);
		expect(h).not.toHaveProperty("Access-Control-Allow-Credentials");
	});

	it("gives any other origin no Allow-Origin at all (never a reflection or a wildcard)", () => {
		for (const o of ["https://evil.example", `${SANDBOX}.evil.example`, "http://thunderbolt.example.org", null]) {
			expect(syncCorsHeaders(o)).toEqual({ Vary: "Origin" });
		}
	});

	it("a preflight is a 204 whatever the origin", () => {
		expect(syncPreflight(SANDBOX).status).toBe(204);
		expect(syncPreflight("https://evil.example").status).toBe(204);
		expect(syncPreflight("https://evil.example").headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("replaces a credentialed Allow-Origin another layer set", () => {
		const r = new Response("{}", {
			headers: { "Access-Control-Allow-Origin": "https://www.aipotluck.org", "Access-Control-Allow-Credentials": "true" },
		});
		const out = applySyncCors(r, "https://evil.example");
		expect(out.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(out.headers.get("Access-Control-Allow-Credentials")).toBeNull();
	});

	it("covers the sync routes, token and revoke, and nothing else under /chat", () => {
		expect(isSyncCorsPath("/chat/api/v2/sync/changes")).toBe(true);
		expect(isSyncCorsPath("/chat/api/auth/oauth2/token")).toBe(true);
		expect(isSyncCorsPath("/chat/api/auth/oauth2/revoke")).toBe(true);
		expect(isSyncCorsPath("/chat/api/auth/oauth2/consent")).toBe(false);
		expect(isSyncCorsPath("/chat/api/v2/conversations")).toBe(false);
	});
});

describe("push body", () => {
	it("a delete row needs only its id or clientId", () => {
		const ok = pushBodySchema.safeParse({
			v: 1,
			conversations: [{ clientId: "c", deletedAt: "2026-10-21T00:00:00.000Z" }],
			messages: [{ id: "m", deletedAt: "2026-10-21T00:00:00.000Z" }],
		});
		expect(ok.success).toBe(true);
	});

	it("a new message without a role, content or conversation is refused", () => {
		expect(pushBodySchema.safeParse({ v: 1, messages: [{ clientId: "m", conversationClientId: "c" }] }).success).toBe(false);
		expect(pushBodySchema.safeParse({ v: 1, messages: [{ clientId: "m", role: "user", content: "x" }] }).success).toBe(false);
		expect(pushBodySchema.safeParse({ v: 1, messages: [{ role: "user", content: "x", conversationClientId: "c" }] }).success).toBe(false);
	});

	it("an unknown field or version is refused rather than ignored", () => {
		expect(pushBodySchema.safeParse({ v: 2 }).success).toBe(false);
		expect(pushBodySchema.safeParse({ v: 1, conversations: [{ clientId: "c", owner: "someone" }] }).success).toBe(false);
	});
});

describe("wire mapping", () => {
	const msg = (id: string, from: Message["from"], ancestors: string[], extra: Partial<Message> = {}): Message => ({
		id,
		from,
		content: id,
		ancestors,
		children: [],
		...extra,
	});

	it("sends the live branch only, without the system prompt, and marks each row's origin", () => {
		const messages = [
			msg("root", "system", []),
			msg("q", "user", ["root"]),
			msg("old", "assistant", ["root", "q"]),
			msg("new", "assistant", ["root", "q"], { origin: "thunderbolt-sandbox", syncClientId: "tb-1" }),
		];
		expect(liveBranch(messages).map((m) => m.id)).toEqual(["q", "new"]);
		const c = toConversationV1({ _id: new ObjectId(), title: "t", model: "m", messages, updatedAt: new Date(1) } as never);
		expect(c.origin).toBe("alpha");
		expect(c.messages.map((m) => [m.id, m.origin, m.clientId])).toEqual([
			["q", "alpha", null],
			["new", "thunderbolt-sandbox", "tb-1"],
		]);
	});

	it("removing a message takes its subtree and unlinks it from its parent", () => {
		const out = removeMessage(
			[msg("root", "system", [], { children: ["q"] }), msg("q", "user", ["root"], { children: ["a"] }), msg("a", "assistant", ["root", "q"])],
			"q"
		);
		expect(out.map((m) => m.id)).toEqual(["root"]);
		expect(out[0].children).toEqual([]);
	});

	it("a cursor round-trips both keyset positions, and an unreadable one starts from the beginning", () => {
		const c = { conv: { at: 1234, id: "65f0a1b2c3d4e5f6a7b8c9d0" }, tomb: { at: 99, id: "0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d" } };
		expect(decodeCursor(encodeCursor(c))).toEqual(c);
		expect(decodeCursor(encodeCursor(decodeCursor(null)))).toEqual(decodeCursor(null));
		const start = { conv: { at: 0, id: "" }, tomb: { at: 0, id: "" } };
		expect(decodeCursor(null)).toEqual(start);
		expect(decodeCursor("garbage")).toEqual(start);
		expect(decodeCursor("v1.1234")).toEqual(start);
	});
});

describe("pushed messages", () => {
	const at = new Date(1);
	it("an assistant answer written in Thunderbolt arrives finished, so the page never shows it generating", () => {
		const q = syncedMessage({ clientId: "tb-q", role: "user", content: "q" }, "thunderbolt-sandbox", undefined, at);
		const a = syncedMessage({ clientId: "tb-a", role: "assistant", content: "answer" }, "thunderbolt-sandbox", q, at);
		expect(isConversationGenerationActive([q, a])).toBe(false);
		expect(a.ancestors).toEqual([q.id]);
	});

	it("a user turn carries no answer updates", () => {
		const q = syncedMessage({ clientId: "tb-q", role: "user", content: "q" }, "thunderbolt-sandbox", undefined, at);
		expect(q.updates).toBeUndefined();
	});
});

describe("sign-in bridge", () => {
	it("rebuilds the authorize request without the plugin's signature or prompt", () => {
		const q = new URLSearchParams({
			client_id: "thunderbolt-sandbox",
			response_type: "code",
			state: "s1",
			prompt: "login",
			sig: "x",
			exp: "1",
			ba_iat: "2",
		});
		const url = new URL(authorizeResumePath(q), "http://localhost");
		expect(url.pathname).toBe("/chat/api/auth/oauth2/authorize");
		expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "response_type", "state"]);
	});
});
