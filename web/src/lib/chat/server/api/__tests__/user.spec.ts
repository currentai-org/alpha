import { describe, it, expect, beforeEach } from "vitest";
import superjson from "superjson";
import { collections } from "$lib/chat/server/database";
import { createTestLocals, createTestUser, cleanupTestData } from "./testHelpers";
import { GET as userGET } from "../../../../../routes/chat/api/v2/user/+server";
import {
	GET as settingsGET,
	POST as settingsPOST,
} from "../../../../../routes/chat/api/v2/user/settings/+server";

async function parseResponse<T = unknown>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

function mockRequestEvent(locals: App.Locals, overrides?: Record<string, unknown>) {
	return {
		locals,
		url: new URL("http://localhost"),
		request: new Request("http://localhost"),
		...overrides,
	} as Parameters<typeof userGET>[0];
}

describe("GET /api/v2/user", () => {
	beforeEach(async () => {
		await cleanupTestData();
	}, 20000);

	it("returns user info for authenticated user", async () => {
		const { user, locals } = await createTestUser();

		const res = await userGET(mockRequestEvent(locals));
		const data = await parseResponse<Record<string, unknown>>(res);

		expect(data).not.toBeNull();
		expect(data).toMatchObject({
			id: user._id.toString(),
			username: user.username,
			avatarUrl: user.avatarUrl,
			isAdmin: false,
			isEarlyAccess: false,
		});
	});

	it("returns null for unauthenticated user", async () => {
		const locals = createTestLocals();

		const res = await userGET(mockRequestEvent(locals));
		const data = await parseResponse(res);

		expect(data).toBeNull();
	});
});

describe("GET /api/v2/user/settings", () => {
	beforeEach(async () => {
		await cleanupTestData();
	}, 20000);

	it("returns default settings when none exist", async () => {
		const { locals } = await createTestUser();

		const res = await settingsGET(mockRequestEvent(locals));
		const data = await parseResponse<Record<string, unknown>>(res);

		expect(data).toMatchObject({
			welcomeModalSeen: false,
			welcomeModalSeenAt: null,
			streamingMode: "smooth",
			directPaste: false,
			shareConversationsWithModelAuthors: true,
			customPrompts: {},
			multimodalOverrides: {},
		});
	});

	it("returns stored settings with canonical streaming mode", async () => {
		const { user, locals } = await createTestUser();

		await collections.settings.insertOne({
			userId: user._id,
			shareConversationsWithModelAuthors: false,
			activeModel: "custom-model",
			streamingMode: "raw",
			directPaste: true,
			hapticsEnabled: true,
			customPrompts: { "my-model": "Be helpful" },
			multimodalOverrides: {},
			hidePromptExamples: {},
			welcomeModalSeenAt: new Date("2024-01-01"),
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const res = await settingsGET(mockRequestEvent(locals));
		const data = await parseResponse<Record<string, unknown>>(res);

		expect(data).toMatchObject({
			welcomeModalSeen: true,
			shareConversationsWithModelAuthors: false,
			streamingMode: "raw",
			directPaste: true,
			customPrompts: { "my-model": "Be helpful" },
		});
	});

	it("maps legacy stored streamingMode=final to smooth", async () => {
		const { user, locals } = await createTestUser();

		const legacySettingsWithFinal = {
			userId: user._id,
			shareConversationsWithModelAuthors: true,
			activeModel: "custom-model",
			streamingMode: "final",
			directPaste: false,
			customPrompts: {},
			multimodalOverrides: {},
			hidePromptExamples: {},
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		await collections.settings.insertOne(
			legacySettingsWithFinal as unknown as Parameters<typeof collections.settings.insertOne>[0]
		);

		const res = await settingsGET(mockRequestEvent(locals));
		const data = await parseResponse<Record<string, unknown>>(res);

		expect(data).toMatchObject({
			streamingMode: "smooth",
		});
	});
});

describe("POST /api/v2/user/settings", () => {
	beforeEach(async () => {
		await cleanupTestData();
	}, 20000);

	it("creates settings with upsert", async () => {
		const { user, locals } = await createTestUser();

		const body = {
			activeModel: "test-model",
			customPrompts: {},
			multimodalOverrides: {},
			streamingMode: "raw",
			directPaste: false,
			hidePromptExamples: {},
		};

		const res = await settingsPOST(
			mockRequestEvent(locals, {
				request: new Request("http://localhost", {
					method: "POST",
					body: JSON.stringify(body),
					headers: { "Content-Type": "application/json" },
				}),
			})
		);

		expect(res.status).toBe(200);

		const stored = await collections.settings.findOne({ userId: user._id });
		expect(stored).not.toBeNull();
		expect(stored?.streamingMode).toBe("raw");
		expect(stored?.createdAt).toBeInstanceOf(Date);
		expect(stored?.updatedAt).toBeInstanceOf(Date);
	});

	it("sets welcomeModalSeenAt when welcomeModalSeen is true", async () => {
		const { user, locals } = await createTestUser();

		const body = {
			welcomeModalSeen: true,
			activeModel: "test-model",
			customPrompts: {},
			multimodalOverrides: {},
			streamingMode: "smooth",
			directPaste: false,
			hidePromptExamples: {},
		};

		await settingsPOST(
			mockRequestEvent(locals, {
				request: new Request("http://localhost", {
					method: "POST",
					body: JSON.stringify(body),
					headers: { "Content-Type": "application/json" },
				}),
			})
		);

		const stored = await collections.settings.findOne({ userId: user._id });
		expect(stored).not.toBeNull();
		expect(stored?.welcomeModalSeenAt).toBeInstanceOf(Date);
	});

	// A write persists only the fields it names. The schema fills a default for every
	// absent field, so without that a save that left `streamingMode` out would reset a saved `raw`. (CUR-1643)
	const postSettings = (locals: App.Locals, body: unknown) =>
		settingsPOST(
			mockRequestEvent(locals, {
				request: new Request("http://localhost", {
					method: "POST",
					body: JSON.stringify(body),
					headers: { "Content-Type": "application/json" },
				}),
			})
		);

	it("writes no defaults for fields the body leaves out, so an empty body stores none", async () => {
		const { user, locals } = await createTestUser();

		const res = await postSettings(locals, {});

		expect(res.status).toBe(200);
		const stored = await collections.settings.findOne({ userId: user._id });
		expect(stored).not.toBeNull();
		expect(stored?.streamingMode).toBeUndefined();
		expect(stored?.directPaste).toBeUndefined();
		expect(stored?.customPrompts).toBeUndefined();
	});

	it("keeps a saved field when a later write names only other fields (two tabs, one row)", async () => {
		const { user, locals } = await createTestUser();

		await postSettings(locals, { streamingMode: "raw" });
		await postSettings(locals, { directPaste: true });
		await postSettings(locals, { welcomeModalSeen: true });

		const stored = await collections.settings.findOne({ userId: user._id });
		expect(stored?.streamingMode).toBe("raw");
		expect(stored?.directPaste).toBe(true);
		expect(stored?.welcomeModalSeenAt).toBeInstanceOf(Date);
	});

	it("still rejects an invalid value in a field the body does name", async () => {
		const { locals } = await createTestUser();

		await expect(postSettings(locals, { streamingMode: "sideways" })).rejects.toThrow();
	});
});
