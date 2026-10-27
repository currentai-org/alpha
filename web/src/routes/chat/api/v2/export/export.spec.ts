import { describe, expect, it, vi, afterEach } from "vitest";
import { unzipSync } from "fflate";
import { userPrefix } from "$lib/chat/server/storage/custodialBucket";
import { collections } from "$lib/chat/server/database";
import { eq, getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import {
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";
import {
	EXPORT_FORMAT,
	EXPORT_SCHEMA_VERSION,
	ExportFileError,
	validateExportFile,
} from "$lib/chat/server/exportFormat";

// Contract test for the export route (CUR-1017). The load-bearing property is the TEXT-ONLY-ALPHA guard in
// +server.ts: `(multimodalEnabled() ? hashes : [])`. A merge that resolves this back to plain `hashes`
// would silently start embedding real file bytes in every export. That regression is what this file exists
// to catch, not merely "the route returns something."

const dataExportEnabledMock = vi.fn(() => true);
// The flag is stubbed where PostHog would answer it, in flags.ts, so the route's real gate runs:
// dataExportEnabled() and requireExportUser() both come from dataPortability.ts, and a stub on that
// module's export never reaches the call requireExportUser makes inside it. nextExportAt is the real one too, so the 429 test below
// exercises the real one-an-hour read against the database.
vi.mock("$lib/chat/server/flags", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/chat/server/flags")>();
	return {
		...actual,
		flagEnabledOr: (key: string, fallback: () => boolean) =>
			key === "data-export" ? dataExportEnabledMock() : actual.flagEnabledOr(key, fallback),
	};
});

const multimodalEnabledMock = vi.fn(() => false);
vi.mock("$lib/chat/server/textOnly", () => ({
	multimodalEnabled: () => multimodalEnabledMock(),
}));

// Stubbed to actually SUCCEED (real bytes back), not just left to hit a real store and 404 on a fake
// hash — a 404 would make the guard's absence indistinguishable from its presence (both end up with
// zero files in the zip), which is exactly the hollow-check shape this repo's test rules warn against:
// "it must go red for THE FAILURE IT NAMES, not merely be capable of going red." With this stub, the
// multimodalEnabled() guard is the ONLY thing standing between a files reference and real bytes in the
// output — so removing the guard is what the injury test below actually exercises.
const downloadFileMock = vi.fn(async () => ({
	type: "base64" as const,
	name: "abc-12345678",
	value: Buffer.from("real file bytes that must never leave in a text-only export").toString("base64"),
	mime: "text/plain",
}));
vi.mock("$lib/chat/server/files/downloadFile", () => ({
	downloadFile: () => downloadFileMock(),
}));

// Alpha storage is off unless a test turns it on, so the tests above it see the route they always saw.
const storage = {
	configured: vi.fn(() => false),
	list: vi.fn(async (): Promise<{ path: string; type: "file"; size: number }[]> => []),
	download: vi.fn(async (): Promise<Blob | null> => new Blob(["stored bytes"])),
};
vi.mock("$lib/chat/server/storage/custodialStorage", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/storage/custodialStorage")>()),
	custodialStorageConfigured: () => storage.configured(),
	listCustodialFiles: () => storage.list(),
	downloadCustodialFile: () => storage.download(),
}));

async function readZipBuffer(response: Response): Promise<Buffer> {
	const arrayBuffer = await response.arrayBuffer();
	return Buffer.from(arrayBuffer);
}

describe.sequential("GET /chat/api/v2/export (CUR-1017)", () => {
	afterEach(async () => {
		await cleanupTestData();
		await collections.messageEvents.deleteMany({});
		dataExportEnabledMock.mockReturnValue(true);
		multimodalEnabledMock.mockReturnValue(false);
		storage.configured.mockReturnValue(false);
		storage.list.mockResolvedValue([]);
		downloadFileMock.mockClear();
	});

	it("returns a real zip for a signed-in non-admin, not just an admin (CUR-995)", async () => {
		const { locals } = await createTestUser();
		const { GET } = await import("./+server");
		const response = await GET({ locals } as Parameters<typeof GET>[0]);
		const buffer = await readZipBuffer(response);
		expect(buffer.includes("conversations.json")).toBe(true);
	});

	it("conversations.json names its format, version and account, and our own validator accepts it (CUR-4180)", async () => {
		const { locals } = await createTestUser();
		const accountId = locals.user!._id.toString();
		await createTestConversation(locals, { title: "Envelope check" });
		const { GET } = await import("./+server");
		const zip = unzipSync(new Uint8Array(await readZipBuffer(await GET({ locals } as Parameters<typeof GET>[0]))));
		const text = Buffer.from(zip["conversations.json"]).toString();

		const file = JSON.parse(text);
		expect(file).toMatchObject({ format: EXPORT_FORMAT, schemaVersion: EXPORT_SCHEMA_VERSION, account: { id: accountId } });
		expect(Number.isNaN(Date.parse(file.exportedAt))).toBe(false);
		expect(file.conversations.map((c: { title: string }) => c.title)).toEqual(["Envelope check"]);

		expect(validateExportFile(text, accountId).conversations).toHaveLength(1);
		expect(() => validateExportFile(text, "someone-else")).toThrow(ExportFileError);
		const readmeText = Buffer.from(zip["README.md"]).toString();
		expect(readmeText).toContain(`"format": "${EXPORT_FORMAT}"`);
		expect(readmeText).toContain(`"schemaVersion": ${EXPORT_SCHEMA_VERSION}`);
	});

	it("401s a signed-out request", async () => {
		const { GET } = await import("./+server");
		await expect(GET({ locals: {} } as Parameters<typeof GET>[0])).rejects.toMatchObject({
			status: 401,
		});
	});

	it("403s when the data-export flag is off, even for an admin", async () => {
		dataExportEnabledMock.mockReturnValue(false);
		const { locals } = await createTestUser();
		locals.isAdmin = true;
		const { GET } = await import("./+server");
		await expect(GET({ locals } as Parameters<typeof GET>[0])).rejects.toMatchObject({
			status: 403,
		});
	});

	it("429s a second export within the hour", async () => {
		const { user, locals } = await createTestUser();
		locals.isAdmin = true;
		await collections.messageEvents.insertOne({
			userId: user._id,
			type: "export",
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 1000 * 60 * 60),
		});
		const { GET } = await import("./+server");
		await expect(GET({ locals } as Parameters<typeof GET>[0])).rejects.toMatchObject({
			status: 429,
		});
	});

	it("sends a throttled click on a stale Account page back to that page instead of a bare 429 (CUR-3849)", async () => {
		const { user, locals } = await createTestUser();
		locals.isAdmin = true;
		await collections.messageEvents.insertOne({
			userId: user._id,
			type: "export",
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 1000 * 60 * 60),
		});
		const { GET } = await import("./+server");
		const navigate = new Request("http://localhost/chat/api/v2/export", {
			headers: { "sec-fetch-mode": "navigate" },
		});
		await expect(GET({ locals, request: navigate } as Parameters<typeof GET>[0])).rejects.toMatchObject({
			status: 303,
			location: "/chat/settings/account",
		});
		const fetchCall = new Request("http://localhost/chat/api/v2/export", {
			headers: { "sec-fetch-mode": "cors" },
		});
		await expect(GET({ locals, request: fetchCall } as Parameters<typeof GET>[0])).rejects.toMatchObject({
			status: 429,
		});
	});

	it("never embeds file bytes when multimodal is off, even for a conversation with a files reference", async () => {
		const { locals } = await createTestUser();
		locals.isAdmin = true;
		await createTestConversation(locals, {
			messages: [
				{
					from: "user",
					id: crypto.randomUUID(),
					content: "hello",
					files: [{ type: "hash", name: "abc-12345678", value: "fake-hash-1", mime: "text/plain" }],
				},
			],
		});

		const { GET } = await import("./+server");
		const response = await GET({ locals } as Parameters<typeof GET>[0]);
		const buffer = await readZipBuffer(response);

		// A ZIP's filenames are stored as literal ASCII in the local-file-header and central directory
		// regardless of the entry's own compression — a raw byte scan for the export route's own
		// "file-" naming prefix is a reliable presence/absence check without needing a zip-reading
		// dependency this repo doesn't otherwise carry.
		expect(buffer.includes("file-")).toBe(false);
		expect(buffer.includes("conversations.json")).toBe(true);
	});

	it("includes a person's human evaluation profile and ratings, and leaves the file out for everyone else", async () => {
		const { GET } = await import("./+server");
		const without = await createTestUser();
		expect((await readZipBuffer(await GET({ locals: without.locals } as Parameters<typeof GET>[0]))).includes("human-evaluation.json")).toBe(false);

		const { locals } = await createTestUser();
		const userId = locals.user!._id.toString();
		const db = getDb();
		await db.insert(schema.humanEvalRuns).values({
			id: "export-spec-run",
			taskSetVersion: "v1",
			taskId: "t01-rice",
			language: "fra",
			modelId: "m",
			prompt: "p",
			response: "r",
		});
		await db.insert(schema.humanEvalProfiles).values({ id: "export-spec-profile", userId, language: "fra", level: "native", consentVersion: "c1" });
		await db.insert(schema.humanEvalRatings).values({
			id: "export-spec-rating",
			userId,
			runId: "export-spec-run",
			language: "fra",
			taskId: "t01-rice",
			modelId: "m",
			declaredLevel: "native",
			rubricVersion: "r1",
			taskSetVersion: "v1",
			scores: { task: 4 },
			durationMs: 30_000,
			validity: "valid",
		});
		try {
			const buffer = await readZipBuffer(await GET({ locals } as Parameters<typeof GET>[0]));
			expect(buffer.includes("human-evaluation.json")).toBe(true);
		} finally {
			await db.delete(schema.humanEvalRatings).where(eq(schema.humanEvalRatings.userId, userId));
			await db.delete(schema.humanEvalProfiles).where(eq(schema.humanEvalProfiles.userId, userId));
			await db.delete(schema.humanEvalRuns).where(eq(schema.humanEvalRuns.id, "export-spec-run"));
		}
	});

	// A chat attachment kept in Alpha storage is both a message's file and an entry in the
	// account's listing (CUR-3327). Written from both, the ZIP would hold it twice and the summary count it twice.
	async function accountWithStoredAttachment() {
		multimodalEnabledMock.mockReturnValue(true);
		storage.configured.mockReturnValue(true);
		const { user, locals } = await createTestUser();
		const sha = "a".repeat(64);
		const conversation = await createTestConversation(locals, {
			messages: [
				{
					from: "user",
					id: crypto.randomUUID(),
					content: "what is in this photo",
					files: [{ type: "hash", name: "photo.png", value: sha, mime: "image/png" }],
				},
			],
		});
		const key = `conversations/${conversation._id.toString()}/${sha}/photo.png`;
		const prefix = userPrefix(user._id.toString());
		storage.list.mockResolvedValue([
			{ path: prefix + key, type: "file", size: 12 },
			{ path: prefix + "documents/notes.txt", type: "file", size: 12 },
		]);
		return { locals, key };
	}

	it("each stored file appears once in the export", async () => {
		const { locals, key } = await accountWithStoredAttachment();
		const { GET } = await import("./+server");
		const zip = unzipSync(new Uint8Array(await readZipBuffer(await GET({ locals } as Parameters<typeof GET>[0]))));
		const names = Object.keys(zip);

		expect(names.filter((name) => name.startsWith("attachments/"))).toEqual([]);
		expect(names.filter((name) => name.startsWith("files/")).sort()).toEqual(
			[`files/${key}`, "files/documents/notes.txt"].sort()
		);
		expect(downloadFileMock).not.toHaveBeenCalled();
		// The conversation still says which file its message carried, pointing at the one copy.
		expect(Buffer.from(zip["conversations.json"]).toString()).toContain(`files/${key}`);
	});

	// The readable copy named no attachment, and the README said every stored file sat "in the
	// folders you put them in" while chat attachments sit under the conversation's id and the file's hash. (CUR-4359)
	it("the readable conversation names its attachment's path, and the README says where chat attachments are", async () => {
		const { locals, key } = await accountWithStoredAttachment();
		const { GET } = await import("./+server");
		const zip = unzipSync(new Uint8Array(await readZipBuffer(await GET({ locals } as Parameters<typeof GET>[0]))));
		const readable = Object.keys(zip).find((name) => name.startsWith("conversations/") && name.endsWith(".md"));
		expect(Buffer.from(zip[readable ?? ""]).toString()).toContain(
			`what is in this photo\n\nAttached: \`files/${key}\``
		);
		const readmeText = Buffer.from(zip["README.md"]).toString();
		expect(readmeText).toContain("A file you attached in a chat is under `files/conversations/`");
		expect(readmeText).not.toMatch(/stored with us, in the folders you put them in/);
	});

	it("the summary counts a stored attachment once", async () => {
		const { locals } = await accountWithStoredAttachment();
		const { GET } = await import("./summary/+server");
		const response = await GET({ locals } as Parameters<typeof GET>[0]);
		expect((await response.json()).files).toBe(2);
	});
});

// CUR-4183. The export reads conversations and files today, so no credential reaches it. That holds
// only while nobody widens what it reads: a column that holds a sign-in token, an OAuth grant or a
// tunnel secret is one join away. So the test below gives a person a value in every credential column
// the schema has, runs the real export, and looks for each value in every file of the ZIP. The walk
// after it keeps that list complete: a new column whose name says it holds a credential fails until it
// is seeded here or exempted with a reason.
const CREDENTIAL_NAME = /token|secret|password|credential/i;

/** Credential-named columns the leak test does not seed, each with why it is not a secret. */
const NOT_SECRET: Record<string, string> = {
	"account.accessTokenExpiresAt": "A timestamp, not the token.",
	"account.refreshTokenExpiresAt": "A timestamp, not the token.",
	"passkey.credentialID":
		"The public WebAuthn credential id: the authenticator hands it to the site at every sign-in.",
	"oauth_client.clientCredentialsScopes": "The scopes a client may ask for, not a credential.",
	"oauth_client.tokenEndpointAuthMethod": "How the client authenticates (none, for a public PKCE client).",
	"oauth_client.dpopBoundAccessTokens": "A boolean setting on the client.",
	"oauth_resource.accessTokenTtl": "A lifetime in seconds.",
	"oauth_resource.refreshTokenTtl": "A lifetime in seconds.",
	"oauth_resource.dpopBoundAccessTokensRequired": "A boolean setting on the resource.",
};

/** Seeds one value in every credential column, and returns `table.column` → that value. */
async function personWithEveryCredential(locals: App.Locals) {
	const db = getDb();
	const userId = locals.user!._id.toString();
	const tag = userId.slice(-8);
	const leak = (column: string) => `leak-${column}-${tag}`;
	await db.insert(schema.users).values({ id: userId, doc: {} }).onConflictDoNothing();
	await db.insert(schema.user).values({ id: userId, name: "Leak Test", email: `leak-${tag}@example.org` });
	await db.insert(schema.session).values({
		id: `s-${tag}`,
		userId,
		token: leak("session.token"),
		expiresAt: new Date(Date.now() + 3_600_000),
	});
	await db.insert(schema.account).values({
		id: `a-${tag}`,
		userId,
		providerId: "google",
		accountId: `g-${tag}`,
		accessToken: leak("account.accessToken"),
		refreshToken: leak("account.refreshToken"),
		idToken: leak("account.idToken"),
		password: leak("account.password"),
	});
	await db.insert(schema.storageLocations).values({
		id: `loc-${tag}`,
		userId,
		kind: "hf-bucket",
		label: "Walk notes",
		config: { repo: `buckets/walker/notes-${tag}`, prefix: "", grant: "oauth" },
		credential: leak("storage_locations.credential"),
	});
	await db.insert(schema.userMcpServers).values({
		id: `mcp-${tag}`,
		userId,
		name: "notes",
		url: "https://mcp.example.org/",
		credential: leak("user_mcp_servers.credential"),
	});
	await db.insert(schema.localInferencePairings).values({
		pairingIdHash: `pair-${tag}`,
		userId,
		credentials: {
			endpointId: `ep-${tag}`,
			label: "Laptop",
			installArgs: {
				tunnelId: `tun-${tag}`,
				tunnelSecret: leak("local_inference_pairings.credentials"),
				tunnelEndpoint: "https://tunnel.example.org",
			},
		},
		expiresAt: new Date(Date.now() + 3_600_000),
	});
	await db.insert(schema.tokenCaches).values({
		id: `tc-${tag}`,
		userId,
		tokenHash: leak("token_caches.tokenHash"),
		doc: {},
	});
	// An OAuth client this person registered, and a grant to it (CUR-4312): its secret and both tokens.
	await db.insert(schema.oauthClient).values({
		id: `oc-${tag}`,
		clientId: `client-${tag}`,
		clientSecret: leak("oauth_client.clientSecret"),
		userId,
		redirectUris: ["https://client.example.org/callback"],
	});
	await db.insert(schema.oauthRefreshToken).values({
		id: `ort-${tag}`,
		token: leak("oauth_refresh_token.token"),
		clientId: `client-${tag}`,
		userId,
		expiresAt: new Date(Date.now() + 3_600_000),
		scopes: ["conversations:sync"],
	});
	await db.insert(schema.oauthAccessToken).values({
		id: `oat-${tag}`,
		token: leak("oauth_access_token.token"),
		clientId: `client-${tag}`,
		userId,
		refreshId: `ort-${tag}`,
		expiresAt: new Date(Date.now() + 3_600_000),
		scopes: ["conversations:sync"],
	});
	return {
		tokenCacheId: `tc-${tag}`,
		seeded: {
			"session.token": leak("session.token"),
			"account.accessToken": leak("account.accessToken"),
			"account.refreshToken": leak("account.refreshToken"),
			"account.idToken": leak("account.idToken"),
			"account.password": leak("account.password"),
			"storage_locations.credential": leak("storage_locations.credential"),
			"user_mcp_servers.credential": leak("user_mcp_servers.credential"),
			"local_inference_pairings.credentials": leak("local_inference_pairings.credentials"),
			"token_caches.tokenHash": leak("token_caches.tokenHash"),
			"oauth_client.clientSecret": leak("oauth_client.clientSecret"),
			"oauth_refresh_token.token": leak("oauth_refresh_token.token"),
			"oauth_access_token.token": leak("oauth_access_token.token"),
		} as Record<string, string>,
	};
}

describe.sequential("the data export never carries a credential (CUR-4183)", () => {
	let tokenCacheId: string | undefined;
	afterEach(async () => {
		// token_caches has no foreign key to cascade from, so cleanupTestData would leave the row.
		if (tokenCacheId) await getDb().delete(schema.tokenCaches).where(eq(schema.tokenCaches.id, tokenCacheId));
		tokenCacheId = undefined;
		await cleanupTestData();
		storage.configured.mockReturnValue(false);
		storage.list.mockResolvedValue([]);
	});

	it("no file in the ZIP contains a session token, OAuth token, storage or connector credential, or tunnel secret", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "Tide tables for Saturday" });
		const fixture = await personWithEveryCredential(locals);
		tokenCacheId = fixture.tokenCacheId;
		storage.configured.mockReturnValue(true);
		storage.list.mockResolvedValue([{ path: `${userPrefix(locals.user!._id.toString())}notes.txt`, type: "file", size: 12 }]);

		const { GET } = await import("./+server");
		const response = await GET({ locals } as Parameters<typeof GET>[0]);
		expect(response.status).toBe(200);
		const zip = unzipSync(new Uint8Array(await readZipBuffer(response)));
		const everything = Object.entries(zip)
			.map(([name, bytes]) => `${name}\n${Buffer.from(bytes).toString("utf8")}`)
			.join("\n");

		// The export did read this person's data, so an absence below is about the credentials.
		expect(everything).toContain("Tide tables for Saturday");
		const leaked = Object.entries(fixture.seeded).filter(([, value]) => everything.includes(value));
		expect(leaked.map(([column]) => column)).toEqual([]);
		// The legacy chat session id is the cookie's key and is never spread into an export record.
		expect(everything).not.toContain(locals.sessionId);
	});

	it("every credential-named column in the schema is seeded by the leak test or exempted with a reason", async () => {
		const { locals } = await createTestUser();
		const fixture = await personWithEveryCredential(locals);
		tokenCacheId = fixture.tokenCacheId;

		const named: string[] = [];
		for (const table of Object.values(schema)) {
			if (!is(table, PgTable)) continue;
			for (const column of Object.keys(getTableColumns(table))) {
				if (CREDENTIAL_NAME.test(column)) named.push(`${getTableName(table)}.${column}`);
			}
		}
		const uncovered = named.filter((key) => !(key in fixture.seeded) && !(key in NOT_SECRET));
		expect(uncovered).toEqual([]);
		// And neither list names a column that has gone, so neither can grow stale.
		expect([...Object.keys(fixture.seeded), ...Object.keys(NOT_SECRET)].filter((key) => !named.includes(key))).toEqual([]);
	});
});
