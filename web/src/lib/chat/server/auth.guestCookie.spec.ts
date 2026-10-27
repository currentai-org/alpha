import { describe, it, expect, vi, beforeEach } from "vitest";

// A guest cookie the server never issued is not a session. Before this, any value was
// accepted, and each new value started a fresh per-session rate-limit budget.
//
// Mirrors auth.anonSessionMint.spec.ts's DB mocking, plus a config mock so the signing secret can be
// present or absent per test. (CUR-3191)
const { mockConfig } = vi.hoisted(() => ({ mockConfig: {} as Record<string, string> }));
vi.mock("$lib/chat/server/config", () => ({
	config: new Proxy(
		{},
		{ get: (_t, prop) => (typeof prop === "string" ? (mockConfig[prop] ?? "") : undefined) }
	),
}));

vi.mock("$lib/chat/server/database", () => ({
	collections: {
		sessions: { findOne: vi.fn(async () => null) },
		users: { findOne: vi.fn(async () => null) },
		conversations: { findOne: vi.fn(async () => null) },
		settings: { findOne: vi.fn(async () => null) },
		semaphores: { deleteMany: vi.fn(async () => ({ acknowledged: true, deletedCount: 0 })) },
	},
}));

vi.mock("$app/server", () => ({
	getRequestEvent: () => ({
		getClientAddress: () => "203.0.113.5",
		request: { headers: { get: () => null } },
	}),
}));

vi.mock("$lib/chat/server/betterAuth", () => ({
	getAuth: () => ({ api: { getSession: vi.fn(async () => null) } }),
}));

import { authenticateRequest } from "./auth";
import { collections } from "$lib/chat/server/database";
import { isMintedGuestToken, mintGuestToken } from "./guestSession";
import { sha256 } from "$lib/chat/utils/sha256";

/* eslint-disable @typescript-eslint/no-explicit-any */
const conversationsFindOne = vi.mocked((collections as any).conversations.findOne);
const settingsFindOne = vi.mocked((collections as any).settings.findOne);
const sessionsFindOne = vi.mocked((collections as any).sessions.findOne);
/* eslint-enable @typescript-eslint/no-explicit-any */

const SECRET = "test-secret-not-a-real-one";
const url = new URL("http://localhost/chat/");
const cookieOf = (token: string) =>
	({ get: (name: string) => (name === "hf-chat" ? token : undefined) }) as unknown as Parameters<
		typeof authenticateRequest
	>[1];

beforeEach(() => {
	for (const k of Object.keys(mockConfig)) delete mockConfig[k];
	mockConfig.BETTER_AUTH_SECRET = SECRET;
	conversationsFindOne.mockReset().mockResolvedValue(null);
	settingsFindOne.mockReset().mockResolvedValue(null);
	sessionsFindOne.mockReset().mockResolvedValue(null);
});

describe("guest cookies (CUR-3191)", () => {
	it("re-mints a made-up cookie with nothing saved under it, so a new value never starts a new budget", async () => {
		const made = "attacker-chosen-value-1";
		const result = await authenticateRequest(new Headers(), cookieOf(made), url);

		expect(result.mintedSession).toBe(true);
		expect(result.secretSessionId).not.toBe(made);
		expect(result.sessionId).not.toBe(await sha256(made));
		expect(isMintedGuestToken(result.secretSessionId, SECRET)).toBe(true);
	});

	it("keeps a cookie it minted, without minting again", async () => {
		const token = mintGuestToken(SECRET);
		const result = await authenticateRequest(new Headers(), cookieOf(token), url);

		expect(result.mintedSession).toBeFalsy();
		expect(result.secretSessionId).toBe(token);
		expect(result.sessionId).toBe(await sha256(token));
	});

	it("keeps an unsigned cookie from before signing when a conversation is saved under it", async () => {
		const legacy = "11111111-2222-3333-4444-555555555555";
		conversationsFindOne.mockResolvedValue({ sessionId: await sha256(legacy) });
		const result = await authenticateRequest(new Headers(), cookieOf(legacy), url);

		expect(result.mintedSession).toBeFalsy();
		expect(result.secretSessionId).toBe(legacy);
		expect(conversationsFindOne).toHaveBeenCalledWith({ sessionId: await sha256(legacy) });
	});

	it("keeps an unsigned cookie from before signing when only a setting is saved under it", async () => {
		const legacy = "11111111-2222-3333-4444-666666666666";
		settingsFindOne.mockResolvedValue({ sessionId: await sha256(legacy) });
		const result = await authenticateRequest(new Headers(), cookieOf(legacy), url);

		expect(result.mintedSession).toBeFalsy();
		expect(result.secretSessionId).toBe(legacy);
	});

	it("mints signed values on the cookie-less path too", async () => {
		const noCookies = { get: () => undefined } as unknown as Parameters<typeof authenticateRequest>[1];
		const result = await authenticateRequest(new Headers(), noCookies, url);

		expect(result.mintedSession).toBe(true);
		expect(isMintedGuestToken(result.secretSessionId, SECRET)).toBe(true);
	});

	it("leaves a cookie with a sessions row to the existing session checks, not the guest rule", async () => {
		const token = "oauth-session-token";
		sessionsFindOne.mockResolvedValue({ sessionId: await sha256(token), userId: undefined });
		const result = await authenticateRequest(new Headers(), cookieOf(token), url);

		expect(result.mintedSession).toBeFalsy();
		expect(result.secretSessionId).toBe(token);
		expect(conversationsFindOne).not.toHaveBeenCalled();
	});

	it("accepts any cookie, as before, when no signing secret is configured (fails open, logged)", async () => {
		delete mockConfig.BETTER_AUTH_SECRET;
		const made = "attacker-chosen-value-2";
		const result = await authenticateRequest(new Headers(), cookieOf(made), url);

		expect(result.mintedSession).toBeFalsy();
		expect(result.secretSessionId).toBe(made);
	});
});
