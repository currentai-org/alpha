import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ObjectId } from "bson";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	getLayoutFeatureFlags,
	getLayoutModels,
	getLayoutUser,
	getLayoutSettings,
	getLayoutConversations,
	mapConversationsForSidebar,
	getLayoutPublicConfig,
} from "./layoutData";
import { CONV_NUM_PER_PAGE } from "$lib/chat/constants/pagination";
import { dictationEnabled } from "./dictationMode";
import { csamScanConfigured } from "./storage/csamScan";
import { thunderboltExportEnabled } from "./dataPortability";
import { custodialStorageViewEnabledForUser } from "./storage/custodialStorageGate";
import { getDb } from "./db/client";
import { localInferenceEndpoints } from "./db/schema";
import { newId } from "./db/ids";
import { LOCAL_MODEL_ID_PREFIX, __resetLocalModelsCacheForTests } from "./localModels";
import { collections } from "./database";

// These specs stand a loopback server in for the user's endpoint, so the hosted-deployment SSRF guard
// would refuse it; pass through to plain fetch. localEndpointFetch.spec.ts covers the guard itself.
vi.mock("$lib/chat/server/localEndpointFetch", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/localEndpointFetch")>()),
	localEndpointFetch: (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
}));

// The local-inference gate is a PostHog flag; the wiring tests below drive it directly.
const gateMock = vi.hoisted(() => ({ enabled: true }));
vi.mock("$lib/chat/server/localEndpointsGate", () => ({
	localInferenceEndpointsEnabled: () => gateMock.enabled,
}));

/** A real local HTTP server standing in for a user's local (Ollama-style) endpoint — localModels.ts
 *  now discovers a local endpoint's models live from `{baseUrl}/models` rather than trusting a
 *  hard-coded id, so these tests need something real to answer that call. See localModels.spec.ts for
 *  the fuller discovery/caching coverage; this file only proves the getLayoutModels/getLayoutSettings
 *  wiring itself. */
function startMockLocalServer(modelIds: string[]): { baseURL: string; close: () => Promise<void> } {
	const server: Server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				object: "list",
				data: modelIds.map((id) => ({ id, object: "model", created: 0, owned_by: "ollama" })),
			})
		);
	});
	server.listen(0);
	const { port } = server.address() as AddressInfo;
	return {
		baseURL: `http://127.0.0.1:${port}/v1`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
import {
	createTestLocals,
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "./api/__tests__/testHelpers";

describe("layoutData", () => {
	beforeEach(async () => {
		await cleanupTestData();
	}, 20000);

	it("getLayoutPublicConfig returns an object", async () => {
		const config = await getLayoutPublicConfig();
		expect(config).toBeDefined();
		expect(typeof config).toBe("object");
	});

	// Both flags drive a visible control — the account page's Thunderbolt row and
	// the settings nav's "Storage" tab — and both controls lead somewhere that refuses the
	// request when its own gate says no. So the contract is not "these fields exist": it is that each
	// one equals the gate the destination itself reads. A hardcoded, inverted or stale value here puts
	// a control in front of a person that 403s or 404s when they press it.
	it("never offers export or storage more widely than the gate the destination itself reads", async () => {
		const { locals } = await createTestUser();
		const flags = await getLayoutFeatureFlags(locals);
		expect(flags.thunderboltExportEnabled).toBe(thunderboltExportEnabled());
		expect(flags.custodialStorageEnabled).toBe(
			await custodialStorageViewEnabledForUser(locals.user!._id.toString())
		);
	}, 20000);

	// Signed out there is no account to evaluate the per-user storage gate against, and the page
	// redirects to sign-in before reaching its own gate. The tab must not render for that visitor.
	it("withholds the storage tab from a signed-out visitor", async () => {
		const flags = await getLayoutFeatureFlags(createTestLocals());
		expect(flags.custodialStorageEnabled).toBe(false);
	});

	it("getLayoutFeatureFlags reflects locals.isAdmin", async () => {
		const locals = createTestLocals({ isAdmin: true });
		const flags = await getLayoutFeatureFlags(locals);
		expect(flags.isAdmin).toBe(true);
		// The deploy env under test is neither preview nor production, so the per-user agent gate is
		// closed; the deploy env decides it.
		expect(flags.agentEnabled).toBe(false);
		expect(flags).toHaveProperty("loginEnabled");
		expect(flags).toHaveProperty("agentEnabled");
	});

	// agentModeDefault mirrors agentEnabled — "off" for anyone the per-user gate closes for,
	// since there's nothing to default a hidden toggle to. The "auto" case is just deployEnv() ===
	// preview/production — covered directly by
	// agentMode.spec.ts's agentModeEnabledForUser tests rather than duplicated here, since this field
	// is a thin derivation of that same function.
	it("getLayoutFeatureFlags.agentModeDefault is off when the per-user gate is closed", async () => {
		const locals = createTestLocals();
		const flags = await getLayoutFeatureFlags(locals);
		expect(flags.agentModeDefault).toBe("off");
	});

	// The agent model is registered `unlisted: true` — this is the general filter that excludes
	// it (models.ts), so proving no unlisted model ever survives here holds regardless of whether this
	// test run's environment happens to have the agent registered at all.
	it("getLayoutModels never returns an unlisted model, for any locals", async () => {
		const locals = createTestLocals();
		const result = await getLayoutModels(locals);
		expect(result.every((m) => m.unlisted === false)).toBe(true);
	});

	// localModels.ts's own spec covers resolveLocalModelsForUser/getEffectiveModels in depth; these two
	// prove the actual wiring point — getLayoutModels/getLayoutSettings are what the UI and settings
	// save path read, so this is where a real regression (the splice never reaching the client, or the
	// self-heal check stomping a valid selection) would actually show up.
	describe("getLayoutModels / getLayoutSettings — the per-user local endpoint wiring", () => {
		let servers: Array<{ close: () => Promise<void> }> = [];

		beforeEach(() => {
			gateMock.enabled = true;
			__resetLocalModelsCacheForTests();
			servers = [];
		});

		afterEach(async () => {
			await Promise.all(servers.map((s) => s.close()));
		});

		it("getLayoutModels includes this user's local model(s), and excludes them for a different user", async () => {
			const { user, locals } = await createTestUser();

			const server = startMockLocalServer(["llama3.2:latest"]);
			servers.push(server);
			const endpointId = newId();
			await getDb()
				.insert(localInferenceEndpoints)
				.values({ id: endpointId, userId: user._id.toString(), label: "local", baseUrl: server.baseURL });

			const own = await getLayoutModels(locals);
			expect(own.some((m) => m.id === `${LOCAL_MODEL_ID_PREFIX}${endpointId}:llama3.2:latest`)).toBe(
				true
			);

			const { locals: otherLocals } = await createTestUser();
			const other = await getLayoutModels(otherLocals);
			expect(other.some((m) => m.id.startsWith(LOCAL_MODEL_ID_PREFIX))).toBe(false);
		});

		it("getLayoutSettings does not reset a valid local:* activeModel back to the default", async () => {
			const { user, locals } = await createTestUser();

			const server = startMockLocalServer(["llama3.2:latest"]);
			servers.push(server);
			const endpointId = newId();
			await getDb()
				.insert(localInferenceEndpoints)
				.values({ id: endpointId, userId: user._id.toString(), label: "local", baseUrl: server.baseURL });
			const localModelId = `${LOCAL_MODEL_ID_PREFIX}${endpointId}:llama3.2:latest`;

			await collections.settings.insertOne({
				userId: user._id,
				activeModel: localModelId,
				streamingMode: "smooth",
				directPaste: false,
				hapticsEnabled: true,
				customPrompts: {},
				customPromptsEnabled: {},
				multimodalOverrides: {},
				artifactsOverrides: {},
				reasoningEffortOverrides: {},
				reasoningOverrides: {},
				hidePromptExamples: {},
				welcomeModalSeenAt: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			const settings = await getLayoutSettings(locals);
			expect(settings.activeModel).toBe(localModelId);
		});
	});

	// transcriptionEnabled delegates to the same gate as /chat/api/transcribe, because raw
	// TRANSCRIPTION_MODEL presence could disagree with it (env var set + flag off would show the button
	// and the API would 403). Pinning delegation here — the full flag×config
	// behavior matrix is covered in dictationMode.spec.ts.
	it("getLayoutFeatureFlags.transcriptionEnabled delegates to dictationEnabled(), not raw env presence", async () => {
		const locals = createTestLocals();
		const flags = await getLayoutFeatureFlags(locals);
		expect(flags.transcriptionEnabled).toBe(dictationEnabled());
	});

	// The composer's attach control and My files' drop zone read this flag, and the server
	// refuses every upload when csamScanConfigured is false, so the two must be the same read.
	it("getLayoutFeatureFlags.attachmentsEnabled is csamScanConfigured(), so no control is offered that the server would refuse", async () => {
		const flags = await getLayoutFeatureFlags(createTestLocals());
		expect(flags.attachmentsEnabled).toBe(csamScanConfigured());
	});

	// The settings list's and a failed turn's status links read this, so they lead where the banner's
	// /api/status reads, and nowhere on a self-host with no STATUS_PAGE_URL.
	it("getLayoutFeatureFlags.statusPageUrl is the deployment's own status page, null on a self-host that names none", async () => {
		const saved = { e: process.env.ALPHA_EDITION, u: process.env.STATUS_PAGE_URL };
		try {
			delete process.env.STATUS_PAGE_URL;
			process.env.ALPHA_EDITION = "hosted";
			expect((await getLayoutFeatureFlags(createTestLocals())).statusPageUrl).toBe("https://status.example.test");
			process.env.ALPHA_EDITION = "selfhost";
			expect((await getLayoutFeatureFlags(createTestLocals())).statusPageUrl).toBeNull();
			process.env.STATUS_PAGE_URL = "https://status.example.org";
			expect((await getLayoutFeatureFlags(createTestLocals())).statusPageUrl).toBe("https://status.example.org");
		} finally {
			for (const [k, v] of [["ALPHA_EDITION", saved.e], ["STATUS_PAGE_URL", saved.u]] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("getLayoutUser maps logged-in user", async () => {
		const { locals, user } = await createTestUser();
		const mapped = getLayoutUser(locals);
		expect(mapped).toMatchObject({
			id: user._id.toString(),
			username: user.username,
			isAdmin: false,
		});
	});

	it("getLayoutUser returns null for anonymous locals without user", () => {
		expect(getLayoutUser(createTestLocals())).toBeNull();
	});

	it("getLayoutSettings returns defaults for session-only locals", async () => {
		const locals = createTestLocals({ sessionId: "guest-session" });
		const settings = await getLayoutSettings(locals);
		expect(settings.welcomeModalSeen).toBe(false);
		expect(settings.activeModel).toBeTypeOf("string");
		expect(settings.streamingMode).toMatch(/raw|smooth/);
	});

	it("getLayoutConversations returns sidebar rows for a session", async () => {
		const locals = createTestLocals({ sessionId: "guest-session-2" });
		await createTestConversation(locals, { title: "  Hello  " });

		const { conversations, hasMore } = await getLayoutConversations(locals, 0);
		expect(conversations).toHaveLength(1);
		expect(conversations[0].title).toBe("  Hello  ");
		expect(hasMore).toBe(false);

		const sidebar = mapConversationsForSidebar(conversations, "test-model");
		expect(sidebar[0].title).toBe("Hello");
		expect(sidebar[0].id).toBe(conversations[0]._id.toString());
		expect(sidebar[0].updatedAt).toBeInstanceOf(Date);
	});

	it("getLayoutConversations lists a pinned chat first and keeps an archived chat out of the list", async () => {
		const locals = createTestLocals({ sessionId: "guest-session-pin" });
		await createTestConversation(locals, { title: "newest", updatedAt: new Date("2026-03-01") });
		const pinned = await createTestConversation(locals, {
			title: "pinned old",
			updatedAt: new Date("2026-01-01"),
			pinned: true,
		});
		await createTestConversation(locals, { title: "archived", archived: true });

		const { conversations } = await getLayoutConversations(locals, 0);
		expect(conversations.map((c) => c.title)).toEqual(["pinned old", "newest"]);
		expect(conversations[0]._id.toString()).toBe(pinned._id.toString());
		expect(conversations[0].pinned).toBe(true);

		const archived = await getLayoutConversations(locals, 0, null, "archived");
		expect(archived.conversations.map((c) => c.title)).toEqual(["archived"]);
	});

	it("pages the archived list by cursor, so unarchiving a row between pages skips none", async () => {
		const locals = createTestLocals({ sessionId: "guest-session-archived-cursor" });
		const total = CONV_NUM_PER_PAGE * 2 + 5;
		// Two chats share one instant, straddling the first page boundary, to pin the tie-break on id.
		const tie = new Date("2026-02-01T00:00:00.000Z");
		for (let i = 0; i < total; i++) {
			const atBoundary = i === CONV_NUM_PER_PAGE - 1 || i === CONV_NUM_PER_PAGE;
			await createTestConversation(locals, {
				title: `a${i}`,
				archived: true,
				updatedAt: atBoundary ? tie : new Date(Date.UTC(2026, 0, 1) + (total - i) * 60_000),
			});
		}
		const all = await getLayoutConversations(locals, 0, null, "archived");
		expect(all.hasMore).toBe(true);
		const first = all.conversations;
		const last = first[first.length - 1];
		const cursor = { updatedAt: new Date(last.updatedAt), id: last._id.toString() };

		// The server list shortens by one before the next page is asked for.
		await collections.conversations.updateOne({ _id: first[0]._id }, { $set: { archived: false } });

		const seen = new Set(first.map((c) => c._id.toString()));
		let next = await getLayoutConversations(locals, 0, null, "archived", cursor);
		for (;;) {
			for (const c of next.conversations) seen.add(c._id.toString());
			if (!next.hasMore) break;
			const l = next.conversations[next.conversations.length - 1];
			next = await getLayoutConversations(locals, 0, null, "archived", {
				updatedAt: new Date(l.updatedAt),
				id: l._id.toString(),
			});
		}
		// Every archived chat is seen exactly once across the pages, including the unarchived one from page 0.
		expect(seen.size).toBe(total);
	});

	it("mapConversationsForSidebar falls back to default model id", () => {
		const id = new ObjectId();
		const sidebar = mapConversationsForSidebar(
			[
				{
					_id: id,
					id,
					title: "One",
					updatedAt: new Date("2026-01-01"),
				},
			],
			"fallback-model"
		);
		expect(sidebar[0].model).toBe("fallback-model");
	});
});
