import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/config", () => ({
	config: {
		HF_STORAGE_OAUTH_CLIENT_ID: "storage-client",
		HF_STORAGE_OAUTH_CLIENT_SECRET: "storage-secret",
		PUBLIC_ORIGIN: "https://develop.example.test/",
	},
}));

import {
	authorizeUrl,
	BucketScopeError,
	BucketTakenError,
	bucketNameOk,
	freshGrant,
	OAuthGrantError,
	parseGrant,
	pkcePair,
	provisionAlphaBucket,
	sameRepo,
	serializeGrant,
	storageOAuthApp,
} from "./hfOAuth";
import { createHash } from "node:crypto";

function tokenEndpoint(status: number, body: unknown) {
	const calls: Array<{ url: string; form: URLSearchParams; auth: string | null }> = [];
	const impl = (async (url: string, init: RequestInit) => {
		calls.push({
			url,
			form: init.body as URLSearchParams,
			auth: new Headers(init.headers).get("authorization"),
		});
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe("storageOAuthApp", () => {
	it("builds the callback from PUBLIC_ORIGIN and the chat base, with no doubled slash", () => {
		expect(storageOAuthApp()?.redirectUri).toBe("https://develop.example.test/chat/api/storage/locations/hf/callback");
	});
});

describe("authorizeUrl", () => {
	it("asks for contribute-repos and nothing wider, with an S256 challenge", () => {
		const app = storageOAuthApp();
		if (!app) throw new Error("app unconfigured in test");
		const u = new URL(authorizeUrl(app, "st", "ch"));
		expect(u.searchParams.get("scope")).toBe("openid profile contribute-repos");
		expect(u.searchParams.get("code_challenge_method")).toBe("S256");
		expect(u.searchParams.get("client_id")).toBe("storage-client");
	});
});

describe("pkcePair", () => {
	it("returns a challenge that is the base64url SHA-256 of the verifier", () => {
		const { verifier, challenge } = pkcePair();
		expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
	});
});

describe("freshGrant", () => {
	it("returns the same grant without a network call while the access token has over a minute left", async () => {
		const grant = { access: "a1", refresh: "r1", expiresAt: Date.now() + 10 * 60_000 };
		const { impl, calls } = tokenEndpoint(200, {});
		expect(await freshGrant(grant, impl)).toBe(grant);
		expect(calls).toHaveLength(0);
	});

	it("renews a grant inside the last minute, and keeps the old refresh token when none comes back", async () => {
		const grant = { access: "a1", refresh: "r1", expiresAt: Date.now() + 30_000 };
		const { impl, calls } = tokenEndpoint(200, { access_token: "a2", expires_in: 3600 });
		const fresh = await freshGrant(grant, impl);
		expect(fresh.access).toBe("a2");
		expect(fresh.refresh).toBe("r1");
		expect(fresh.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
		expect(calls[0].form.get("grant_type")).toBe("refresh_token");
		expect(calls[0].form.get("refresh_token")).toBe("r1");
		expect(calls[0].auth).toBe(`Basic ${Buffer.from("storage-client:storage-secret").toString("base64")}`);
	});

	it("takes a rotated refresh token when Hugging Face sends one", async () => {
		const grant = { access: "a1", refresh: "r1", expiresAt: 0 };
		const { impl } = tokenEndpoint(200, { access_token: "a2", refresh_token: "r2", expires_in: 3600 });
		expect((await freshGrant(grant, impl)).refresh).toBe("r2");
	});

	it("throws OAuthGrantError (reconnect), not a plain error, when Hugging Face refuses the refresh", async () => {
		const { impl } = tokenEndpoint(401, { error: "unauthorized_client" });
		await expect(freshGrant({ access: "a1", refresh: "r1", expiresAt: 0 }, impl)).rejects.toBeInstanceOf(OAuthGrantError);
	});

	it("throws a plain error, not reconnect, when the token endpoint is down", async () => {
		const { impl } = tokenEndpoint(502, {});
		const err = await freshGrant({ access: "a1", refresh: "r1", expiresAt: 0 }, impl).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(OAuthGrantError);
	});

	it("throws OAuthGrantError for a stale grant with no refresh token, without calling Hugging Face", async () => {
		const { impl, calls } = tokenEndpoint(200, {});
		await expect(freshGrant({ access: "a1", refresh: null, expiresAt: 0 }, impl)).rejects.toBeInstanceOf(OAuthGrantError);
		expect(calls).toHaveLength(0);
	});
});

describe("parseGrant", () => {
	it("round-trips a serialized grant", () => {
		const grant = { access: "a", refresh: "r", expiresAt: 123 };
		expect(parseGrant(serializeGrant(grant))).toEqual(grant);
	});

	it("returns null for a pasted token, so a token-linked location keeps working unchanged", () => {
		expect(parseGrant("hf_example_token")).toBeNull();
	});
});

describe("bucketNameOk", () => {
	it("takes a Hugging Face repo name and refuses anything that could leave the person's namespace or be refused by the Hub", () => {
		for (const ok of ["alpha-files", "photos", "My_Files.2026", "a"]) expect(bucketNameOk(ok), ok).toBe(true);
		for (const bad of ["", "-lead", ".hidden", "a/b", "../x", "a..b", "x.git", "sp ace", "x".repeat(97)])
			expect(bucketNameOk(bad), bad).toBe(false);
	});

	// A name Hugging Face refuses must be refused by our check too, not read as "try again in a minute". (CUR-4234)
	it("refuses what the Hub refuses: a trailing '-' or '.', and '--' anywhere (CUR-4234)", () => {
		for (const bad of ["trail-", "trail.", "a--b", "café"]) expect(bucketNameOk(bad), bad).toBe(false);
	});

	it("takes '_' at either end and exactly 96 characters, as the Hub does (CUR-4234)", () => {
		for (const ok of ["_x_", "x".repeat(96), "a-b.c_d"]) expect(bucketNameOk(ok), ok).toBe(true);
	});
});

describe("sameRepo", () => {
	it("treats names that differ only in case as one bucket, as Hugging Face does (CUR-4234)", () => {
		expect(sameRepo("buckets/someone/ALPHA-FILES", "buckets/someone/alpha-files")).toBe(true);
		expect(sameRepo("buckets/someone/alpha-files", "buckets/someone/alpha-walk")).toBe(false);
	});
});

/** A Hub that answers the bucket create with `create` and the file listing with `list`. */
function hub(create: number, list: number) {
	return (async (_input: string | URL | Request, init?: RequestInit) => {
		const status = (init?.method ?? "GET") === "POST" ? create : list;
		const body = status < 300 ? "[]" : JSON.stringify({ error: "no" });
		return new Response(body, { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

describe("provisionAlphaBucket", () => {
	const grant = { access: "hf_invented", refresh: null, expiresAt: Date.now() + 3600_000 };

	it("says the name is taken, not that the grant fell short, when the bucket already exists and the grant cannot open it (CUR-4234)", async () => {
		const err = await provisionAlphaBucket("someone", grant, hub(409, 403), "hand-made").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BucketTakenError);
	});

	it("blames the grant when it could not create the bucket at all", async () => {
		const err = await provisionAlphaBucket("someone", grant, hub(403, 403), "fresh").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BucketScopeError);
	});

	it("reuses a bucket this app made before, when the grant can open it", async () => {
		expect(await provisionAlphaBucket("someone", grant, hub(409, 200))).toBe("buckets/someone/alpha-files");
	});
});
