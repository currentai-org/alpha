import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, { userId: string; row: Record<string, unknown> }>();
const prefs = new Map<string, string | null>();
const lastUsed = new Map<string, string>();
const statusWrites: Array<{ id: string; status: string }> = [];
const credentialWrites: string[] = [];

vi.mock("$lib/chat/server/config", () => ({ config: { BETTER_AUTH_SECRET: "registry-test-secret" } }));
vi.mock("$lib/chat/server/db/storageLocations", () => ({
	getStorageLocation: vi.fn(async (userId: string, id: string) => {
		const hit = rows.get(id);
		return hit && hit.userId === userId ? hit.row : null;
	}),
	listStorageLocations: vi.fn(async (userId: string) =>
		[...rows.values()].filter((r) => r.userId === userId).map((r) => r.row)
	),
	getStoragePreferences: vi.fn(async (userId: string) => ({
		defaultLocation: prefs.get(userId) ?? null,
		lastUsedLocation: lastUsed.get(userId) ?? null,
	})),
	setLastUsedStorageLocation: vi.fn(async (userId: string, id: string) => {
		lastUsed.set(userId, id);
	}),
	setStorageLocationStatus: vi.fn(async (_u: string, id: string, status: string) => {
		statusWrites.push({ id, status });
	}),
	setStorageLocationCredential: vi.fn(async (_u: string, id: string) => {
		credentialWrites.push(id);
	}),
}));

const hub = vi.hoisted(() => {
	class HubApiError extends Error {
		constructor(public statusCode: number) {
			super(`hub ${statusCode}`);
		}
	}
	return { HubApiError, next: null as null | (() => Promise<unknown>) };
});
vi.mock("@huggingface/hub", async (orig) => {
	const real = await orig<Record<string, unknown>>();
	const call = () => (hub.next ? hub.next() : Promise.resolve(null));
	return {
		...real,
		HubApiError: hub.HubApiError,
		downloadFile: vi.fn(call),
		deleteFile: vi.fn(call),
		listFiles: vi.fn(async function* () {
			await call();
			yield* [];
		}),
	};
});

import { seal } from "./sealedSecret";
import { serializeGrant } from "./hfOAuth";
import {
	LocationChoiceRequiredError,
	recordUpload,
	resolveLocation,
	resolveUploadLocation,
	summarizeLocations,
} from "./registry";
import { LocationUnavailableError, UnknownLocationError } from "./types";

function link(id: string, userId: string, credential = seal("hf_example", "registry-test-secret"), grant?: "oauth") {
	rows.set(id, {
		userId,
		row: {
			id,
			userId,
			kind: "hf-bucket",
			label: "mine",
			config: { repo: "buckets/me/files", prefix: "", ...(grant ? { grant } : {}) },
			credential,
		},
	});
}

function connect(id: string, userId: string, expiresAt: number) {
	const grant = serializeGrant({ access: "oauth-access", refresh: "oauth-refresh", expiresAt });
	link(id, userId, seal(grant, "registry-test-secret"), "oauth");
}

beforeEach(() => {
	rows.clear();
	prefs.clear();
	lastUsed.clear();
	statusWrites.length = 0;
	credentialWrites.length = 0;
	hub.next = null;
});

describe("resolveLocation", () => {
	it("gives Alpha storage for no id or 'alpha'", async () => {
		expect((await resolveLocation("u1")).kind).toBe("alpha");
		expect((await resolveLocation("u1", "alpha")).kind).toBe("alpha");
	});

	it("gives the account its own linked bucket", async () => {
		link("loc1", "u1");
		expect((await resolveLocation("u1", "loc1")).kind).toBe("hf-bucket");
	});

	it("refuses (UnknownLocationError → 404) another account's location id", async () => {
		link("loc1", "u1");
		await expect(resolveLocation("u2", "loc1")).rejects.toBeInstanceOf(UnknownLocationError);
	});

	it("marks a location needs-reconnect when its credential no longer opens (secret rotated)", async () => {
		link("loc1", "u1", seal("hf_example", "an-older-secret"));
		await expect(resolveLocation("u1", "loc1")).rejects.toBeInstanceOf(LocationUnavailableError);
		expect(statusWrites).toEqual([{ id: "loc1", status: "needs-reconnect" }]);
	});
});

describe("a connected (OAuth) location", () => {
	it("opens with its access token while the grant is current, and writes nothing back", async () => {
		connect("loc1", "u1", Date.now() + 10 * 60_000);
		expect((await resolveLocation("u1", "loc1")).kind).toBe("hf-bucket");
		expect(credentialWrites).toEqual([]);
		expect(statusWrites).toEqual([]);
	});

	it("marks needs-reconnect, with Connect-again wording, when a stale grant cannot be renewed", async () => {
		// The storage OAuth app is not configured in this file's config mock, so renewal is refused.
		connect("loc1", "u1", 0);
		const err = await resolveLocation("u1", "loc1").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LocationUnavailableError);
		expect((err as Error).message).toMatch(/Connect Hugging Face again/);
		expect(statusWrites).toEqual([{ id: "loc1", status: "needs-reconnect" }]);
	});
});

describe("a linked location's status follows what the provider actually says", () => {
	it("reads a file that vanished as null (missing), and leaves the location ok rather than flagging the bucket gone", async () => {
		link("loc1", "u1");
		hub.next = () => Promise.reject(new hub.HubApiError(404));
		const loc = await resolveLocation("u1", "loc1");
		await expect(loc.read("gone.txt")).resolves.toBeNull();
		await expect(loc.delete("gone.txt")).resolves.toBeUndefined();
		expect(statusWrites).toEqual([]);
	});

	it("still flags needs-reconnect when the token is refused (401)", async () => {
		link("loc1", "u1");
		hub.next = () => Promise.reject(new hub.HubApiError(401));
		const loc = await resolveLocation("u1", "loc1");
		await expect(loc.read("a.txt")).rejects.toBeInstanceOf(LocationUnavailableError);
		expect(statusWrites).toEqual([{ id: "loc1", status: "needs-reconnect" }]);
	});

	it("clears needs-reconnect back to ok on the first call that succeeds, so 'Reconnect' does not stick forever", async () => {
		link("loc1", "u1");
		(rows.get("loc1")!.row as Record<string, unknown>).status = "needs-reconnect";
		const loc = await resolveLocation("u1", "loc1");
		await loc.list();
		await loc.list();
		expect(statusWrites).toEqual([{ id: "loc1", status: "ok" }]);
	});
});

describe("resolveUploadLocation: a broken default fails loudly, never silently into Alpha storage", () => {
	it("uses Alpha storage when no default was chosen and nothing was uploaded yet", async () => {
		expect((await resolveUploadLocation("u1")).kind).toBe("alpha");
	});

	it("uses an explicit Alpha storage default even when the last upload went to a linked bucket", async () => {
		link("loc1", "u1");
		prefs.set("u1", "alpha");
		lastUsed.set("u1", "loc1");
		expect((await resolveUploadLocation("u1")).kind).toBe("alpha");
	});

	it("uses the linked default", async () => {
		link("loc1", "u1");
		prefs.set("u1", "loc1");
		expect((await resolveUploadLocation("u1")).id).toBe("loc1");
	});

	it("refuses when the default points at a location that was unlinked", async () => {
		prefs.set("u1", "gone");
		await expect(resolveUploadLocation("u1")).rejects.toBeInstanceOf(LocationUnavailableError);
	});

	it("refuses when the default's credential no longer opens", async () => {
		link("loc1", "u1", seal("hf_example", "an-older-secret"));
		prefs.set("u1", "loc1");
		await expect(resolveUploadLocation("u1")).rejects.toBeInstanceOf(LocationUnavailableError);
	});

	it("asks the client to choose when the default is 'ask', a second location is linked, and the upload named nowhere", async () => {
		link("loc1", "u1");
		prefs.set("u1", "ask");
		await expect(resolveUploadLocation("u1")).rejects.toBeInstanceOf(LocationChoiceRequiredError);
		expect((await resolveUploadLocation("u1", "alpha")).kind).toBe("alpha");
	});
});

describe("CUR-3077: 'Last used' resolves to the most recent upload's location, falling back to Alpha storage", () => {
	it("an account that never chose follows its last upload into its linked bucket", async () => {
		link("loc1", "u1");
		await recordUpload("u1", "loc1");
		expect((await resolveUploadLocation("u1")).id).toBe("loc1");
	});

	it("an explicit 'last' default behaves the same as never choosing", async () => {
		link("loc1", "u1");
		prefs.set("u1", "last");
		lastUsed.set("u1", "loc1");
		expect((await resolveUploadLocation("u1")).id).toBe("loc1");
	});

	it("follows the last upload back to Alpha storage", async () => {
		link("loc1", "u1");
		await recordUpload("u1", "loc1");
		await recordUpload("u1", "alpha");
		expect((await resolveUploadLocation("u1")).kind).toBe("alpha");
	});

	it("falls back to Alpha storage when the last-used location is no longer linked", async () => {
		lastUsed.set("u1", "gone");
		expect((await resolveUploadLocation("u1")).kind).toBe("alpha");
	});

	it("never falls back to another account's location of the same id", async () => {
		link("loc1", "u2");
		lastUsed.set("u1", "loc1");
		expect((await resolveUploadLocation("u1")).kind).toBe("alpha");
	});

	it("refuses loudly, not into Alpha storage, when the last-used bucket is linked but its credential stopped opening", async () => {
		link("loc1", "u1", seal("hf_example", "an-older-secret"));
		lastUsed.set("u1", "loc1");
		await expect(resolveUploadLocation("u1")).rejects.toBeInstanceOf(LocationUnavailableError);
	});
});

describe("CUR-3077: 'ask' asks only when there is more than one place", () => {
	it("a saved 'ask' with only Alpha storage left uploads to Alpha storage with no prompt", async () => {
		prefs.set("u1", "ask");
		expect((await resolveUploadLocation("u1")).kind).toBe("alpha");
	});

	it("summarizeLocations reports 'Last used' as the default for an account that never chose, and where it points", async () => {
		link("loc1", "u1");
		lastUsed.set("u1", "loc1");
		const summary = await summarizeLocations("u1");
		expect(summary.defaultLocation).toBe("last");
		expect(summary.lastUsed).toBe("loc1");
		expect(summary.uploadsGoTo).toBe("loc1");
	});

	it("summarizeLocations reports uploads going to Alpha storage, not 'ask', when Alpha storage is the only place", async () => {
		prefs.set("u1", "ask");
		const summary = await summarizeLocations("u1");
		expect(summary.defaultLocation).toBe("ask");
		expect(summary.uploadsGoTo).toBe("alpha");
		expect(summary.locations).toHaveLength(1);
	});
});
