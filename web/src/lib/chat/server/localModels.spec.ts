import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getDb } from "./db/client";
import { localInferenceEndpoints } from "./db/schema";
import { newId } from "./db/ids";
import { models } from "./models";
import {
	LOCAL_MODEL_ID_PREFIX,
	LOCAL_MODELS_CACHE_TTL_MS,
	resolveLocalModelsForUser,
	getEffectiveModels,
	getEffectiveValidModelIdSchema,
	prewarmLocalModel,
	prewarmLocalModelForUser,
	normalizeLocalBaseUrl,
	isRefusedLocalBaseUrl,
	__resetLocalModelsCacheForTests,
} from "./localModels";
import { endpointOAIParametersSchema } from "./endpoints/openai/endpointOai";
import { createTestLocals, createTestUser, cleanupTestData } from "./api/__tests__/testHelpers";

// The discovery, caching and prewarm specs below run a real server on loopback, which is exactly the
// request the private-address guard refuses on a hosted deployment (CUR-3387). They pass the guard
// through to plain fetch; localEndpointFetch.spec.ts covers the guard itself.
vi.mock("$lib/chat/server/localEndpointFetch", async (importOriginal) => ({
	...(await importOriginal<typeof import("./localEndpointFetch")>()),
	localEndpointFetch: (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
}));

// localInferenceEndpointsEnabled() is a PostHog flag (CUR-3175; localEndpointsGate.spec.ts covers it in
// isolation). It is the one thing gating resolveLocalModelsForUser before it looks at the DB row or the
// network, so these tests drive its answer directly: ON by default, OFF where a test says so.
const gateMock = vi.hoisted(() => ({ enabled: true }));
vi.mock("$lib/chat/server/localEndpointsGate", () => ({
	localInferenceEndpointsEnabled: () => gateMock.enabled,
}));

// normalizeLocalBaseUrl's private-address guard reads DEPLOY_ENV; its specs set it and restore this.
const savedDeployEnv = process.env.DEPLOY_ENV;

async function insertLocalEndpoint(
	userId: string,
	baseUrl: string,
	overrides?: { label?: string; headers?: { name: string; value: string }[] }
) {
	const id = newId();
	await getDb()
		.insert(localInferenceEndpoints)
		.values({
			id,
			userId,
			label: overrides?.label ?? "local",
			baseUrl,
			headers: overrides?.headers ?? [],
		});
	return id;
}

/** A real Node HTTP server standing in for a local Ollama-style OpenAI-compatible endpoint — real TCP,
 *  not a mocked `fetch` (matches this repo's own convention for exercising a real wire, see
 *  endpointOai.spec.ts's CUR-1208 section). Answers `GET /models` with the given model ids in the same
 *  `{data: [{id, ...}]}` envelope models.ts's own catalog fetch parses. `delayMs` lets a test create a
 *  deliberate race window for the in-flight-dedupe assertion. */
function startMockLocalServer(
	modelIds: string[],
	opts?: { delayMs?: number }
): {
	baseURL: string;
	callCount: () => number;
	lastHeaders: () => Record<string, string | string[] | undefined>;
	close: () => Promise<void>;
} {
	let calls = 0;
	let lastHeaders: Record<string, string | string[] | undefined> = {};
	const server: Server = createServer((req, res) => {
		calls++;
		lastHeaders = { ...req.headers };
		const respond = () => {
			if (!req.url?.endsWith("/models")) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					object: "list",
					data: modelIds.map((id) => ({ id, object: "model", created: 0, owned_by: "ollama" })),
				})
			);
		};
		if (opts?.delayMs) {
			setTimeout(respond, opts.delayMs);
		} else {
			respond();
		}
	});
	server.listen(0);
	const { port } = server.address() as AddressInfo;
	return {
		baseURL: `http://127.0.0.1:${port}/v1`,
		callCount: () => calls,
		lastHeaders: () => lastHeaders,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

interface RecordedRequest {
	method: string | undefined;
	url: string | undefined;
	body: string;
	headers: Record<string, string | string[] | undefined>;
}

/** A real Node HTTP server that records every request it receives (method/path/body) and answers 200
 *  to everything — standing in for Ollama's NATIVE API (`/api/generate`) the prewarm call targets,
 *  distinct from `startMockLocalServer`'s OpenAI-compatible `/v1/models` above. Real TCP, same
 *  reasoning as `startMockLocalServer`'s own header comment. */
function startRecordingServer(): {
	nativeBaseURL: string;
	requests: RecordedRequest[];
	close: () => Promise<void>;
} {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			requests.push({
				method: req.method,
				url: req.url,
				body: Buffer.concat(chunks).toString("utf8"),
				headers: { ...req.headers },
			});
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "success" }));
		});
	});
	server.listen(0);
	const { port } = server.address() as AddressInfo;
	return {
		nativeBaseURL: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe("localModels — per-user local inference endpoint, models discovered live from the server", () => {
	let servers: Array<{ close: () => Promise<void> }> = [];

	beforeEach(async () => {
		gateMock.enabled = true;
		await cleanupTestData();
		__resetLocalModelsCacheForTests();
		servers = [];
	}, 20000);

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(servers.map((s) => s.close()));
	});

	it("returns one model per id the local server reports, wired with the real served-model id", async () => {
		const server = startMockLocalServer(["llama3.2:latest", "mistral:latest"]);
		servers.push(server);

		const { user, locals } = await createTestUser();
		const endpointId = await insertLocalEndpoint(user._id.toString(), server.baseURL, { label: "nx16g" });

		const result = await resolveLocalModelsForUser(locals);

		expect(result).toHaveLength(2);
		const ids = result.map((m) => m.id).sort();
		expect(ids).toEqual([
			`${LOCAL_MODEL_ID_PREFIX}${endpointId}:llama3.2:latest`,
			`${LOCAL_MODEL_ID_PREFIX}${endpointId}:mistral:latest`,
		]);
		expect(result.every((m) => m.unlisted === false)).toBe(true);
		// The internal `local:` id is for OUR bookkeeping/selection only — the WIRE request must carry the
		// real model tag the server reported, never the internal id as the literal `model` field (CUR-1194).
		const llama = result.find((m) => m.id === `${LOCAL_MODEL_ID_PREFIX}${endpointId}:llama3.2:latest`);
		expect(llama?.endpoints?.[0]).toMatchObject({
			type: "openai",
			baseURL: server.baseURL,
			modelId: "llama3.2:latest",
			// routerMetadata (via endpointOai.ts's routerModel/routerProvider) must carry the LABELED name,
			// never a raw internal id like "local:20a5be97fcb02afb7ef902d2:llama3.2:latest" (CUR-1194).
			routerModel: "nx16g:llama3.2:latest",
			routerProvider: "local",
		});
		// The name/displayName the picker and every other surface reads is labeled the same way, so
		// two endpoints serving the same wire model tag are still distinguishable by name, not just id.
		expect(llama?.name).toBe("nx16g:llama3.2:latest");
		expect(llama?.displayName).toBe("nx16g:llama3.2:latest");
	});

	it("CUR-3177: a local endpoint's parsed apiKey is the non-secret placeholder, never the gateway key endpointOai defaults to", async () => {
		const server = startMockLocalServer(["llama3.2:latest"]);
		servers.push(server);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), server.baseURL);

		const [model] = await resolveLocalModelsForUser(locals);
		// Parse the way endpointOai does: a missing apiKey takes the schema default, which is
		// OPENAI_API_KEY in any deployment that has one.
		const parsed = endpointOAIParametersSchema.parse({ ...model?.endpoints?.[0], model });
		expect(parsed.apiKey).toBe("sk-local");
		for (const envKey of [process.env.OPENAI_API_KEY, process.env.HF_TOKEN]) {
			if (envKey) expect(parsed.apiKey).not.toBe(envKey);
		}
	});

	it("CUR-1291: an endpoint's custom headers become endpoints[0].defaultHeaders, sent with generation requests", async () => {
		const server = startMockLocalServer(["llama3.2:latest"]);
		servers.push(server);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), server.baseURL, {
			headers: [
				{ name: "Authorization", value: "Bearer test-token" },
				{ name: "X-Tenant", value: "" },
			],
		});

		const result = await resolveLocalModelsForUser(locals);

		expect(result[0]?.endpoints?.[0]).toMatchObject({
			defaultHeaders: { Authorization: "Bearer test-token", "X-Tenant": "" },
		});
	});

	it("CUR-1291: an endpoint with no custom headers gets no defaultHeaders key at all", async () => {
		const server = startMockLocalServer(["llama3.2:latest"]);
		servers.push(server);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), server.baseURL);

		const result = await resolveLocalModelsForUser(locals);

		expect(result[0]?.endpoints?.[0]).not.toHaveProperty("defaultHeaders");
	});

	it("CUR-1291: custom headers are also sent on the model-DISCOVERY request, not just generation — a server behind auth 401s this call just as easily", async () => {
		const server = startMockLocalServer(["llama3.2:latest"]);
		servers.push(server);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), server.baseURL, {
			headers: [{ name: "Authorization", value: "Bearer test-token" }],
		});

		await resolveLocalModelsForUser(locals);

		expect(server.lastHeaders().authorization).toBe("Bearer test-token");
	});

	it("CUR-1262: two endpoints reporting the SAME wire model tag never collide — each keeps its own id and baseURL", async () => {
		const serverA = startMockLocalServer(["llama3.2:latest"]);
		const serverB = startMockLocalServer(["llama3.2:latest"]);
		servers.push(serverA, serverB);

		const { user, locals } = await createTestUser();
		const idA = await insertLocalEndpoint(user._id.toString(), serverA.baseURL, { label: "A" });
		const idB = await insertLocalEndpoint(user._id.toString(), serverB.baseURL, { label: "B" });

		const result = await resolveLocalModelsForUser(locals);

		expect(result).toHaveLength(2);
		const ids = result.map((m) => m.id).sort();
		expect(ids).toEqual(
			[
				`${LOCAL_MODEL_ID_PREFIX}${idA}:llama3.2:latest`,
				`${LOCAL_MODEL_ID_PREFIX}${idB}:llama3.2:latest`,
			].sort()
		);
		const fromA = result.find((m) => m.id === `${LOCAL_MODEL_ID_PREFIX}${idA}:llama3.2:latest`);
		const fromB = result.find((m) => m.id === `${LOCAL_MODEL_ID_PREFIX}${idB}:llama3.2:latest`);
		expect(fromA?.endpoints?.[0]).toMatchObject({ baseURL: serverA.baseURL });
		expect(fromB?.endpoints?.[0]).toMatchObject({ baseURL: serverB.baseURL });
		// This is the actual collision the internal id-namespacing above only half-solves: without the
		// label in name/displayName too, the PICKER would show two rows both literally reading
		// "llama3.2:latest" with no way to tell which is which.
		expect(fromA?.displayName).toBe("A:llama3.2:latest");
		expect(fromB?.displayName).toBe("B:llama3.2:latest");
	});

	it("one unreachable endpoint doesn't hide a different endpoint's models", async () => {
		const reachable = startMockLocalServer(["llama3.2:latest"]);
		servers.push(reachable);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), "http://127.0.0.1:1/v1");
		const goodId = await insertLocalEndpoint(user._id.toString(), reachable.baseURL);

		const result = await resolveLocalModelsForUser(locals);

		expect(result.map((m) => m.id)).toEqual([`${LOCAL_MODEL_ID_PREFIX}${goodId}:llama3.2:latest`]);
	});

	it("returns [] when the local server reports zero models", async () => {
		const server = startMockLocalServer([]);
		servers.push(server);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), server.baseURL);

		expect(await resolveLocalModelsForUser(locals)).toEqual([]);
	});

	it("returns [] for a DIFFERENT user's locals — the access-restriction requirement (no network call needed)", async () => {
		const { user: owner } = await createTestUser();
		await insertLocalEndpoint(owner._id.toString(), "http://127.0.0.1:1/v1");

		const { locals } = await createTestUser();

		expect(await resolveLocalModelsForUser(locals)).toEqual([]);
	});

	it("returns [] when there is no user on locals at all (anonymous)", async () => {
		const { user: owner } = await createTestUser();
		await insertLocalEndpoint(owner._id.toString(), "http://127.0.0.1:1/v1");
		expect(await resolveLocalModelsForUser(createTestLocals())).toEqual([]);
	});

	it("returns [] when there's no row for this user", async () => {
		const { locals } = await createTestUser();

		expect(await resolveLocalModelsForUser(locals)).toEqual([]);
	});

	it("returns [] when the local-inference flag is off, even with a matching row (no network call needed)", async () => {
		gateMock.enabled = false;
		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), "http://127.0.0.1:1/v1");

		expect(await resolveLocalModelsForUser(locals)).toEqual([]);
	});

	it("fails open to [] (not an error) when the local server is unreachable", async () => {
		const { user, locals } = await createTestUser();
		// Port 1 is a real, always-refused port (privileged, nothing listens) — a genuine connection
		// failure, not a mock.
		await insertLocalEndpoint(user._id.toString(), "http://127.0.0.1:1/v1");

		await expect(resolveLocalModelsForUser(locals)).resolves.toEqual([]);
	});

	it("getEffectiveModels appends the local models to the shared catalog, without mutating it", async () => {
		const server = startMockLocalServer(["llama3.2:latest"]);
		servers.push(server);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), server.baseURL);

		const before = models.length;
		const effective = await getEffectiveModels(locals);

		expect(effective.length).toBe(before + 1);
		expect(effective.some((m) => m.id.startsWith(LOCAL_MODEL_ID_PREFIX))).toBe(true);
		// The shared registry export itself is untouched — a later request for a DIFFERENT user must
		// never see this user's local model(s) leak into it.
		expect(models.length).toBe(before);
	});

	it("getEffectiveValidModelIdSchema accepts a discovered model id and rejects a fabricated one", async () => {
		const server = startMockLocalServer(["llama3.2:latest"]);
		servers.push(server);

		const { user, locals } = await createTestUser();
		const endpointId = await insertLocalEndpoint(user._id.toString(), server.baseURL);

		const schema = await getEffectiveValidModelIdSchema(locals);
		expect(schema.safeParse(`${LOCAL_MODEL_ID_PREFIX}${endpointId}:llama3.2:latest`).success).toBe(true);
		expect(schema.safeParse(`${LOCAL_MODEL_ID_PREFIX}${endpointId}:not-a-real-model`).success).toBe(
			false
		);
	});

	it("caches the discovered model list — a second call within the TTL doesn't re-hit the server", async () => {
		const server = startMockLocalServer(["llama3.2:latest"]);
		servers.push(server);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), server.baseURL);

		await resolveLocalModelsForUser(locals);
		await resolveLocalModelsForUser(locals);

		expect(server.callCount()).toBe(1);
	});

	it("re-fetches once the cache entry is older than the TTL", async () => {
		const server = startMockLocalServer(["llama3.2:latest"]);
		servers.push(server);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), server.baseURL);

		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValue(1_000_000);
		await resolveLocalModelsForUser(locals);
		expect(server.callCount()).toBe(1);

		nowSpy.mockReturnValue(1_000_000 + LOCAL_MODELS_CACHE_TTL_MS + 1);
		await resolveLocalModelsForUser(locals);
		expect(server.callCount()).toBe(2);
	});

	it("shares one in-flight fetch across concurrent requests for the same endpoint", async () => {
		const server = startMockLocalServer(["llama3.2:latest"], { delayMs: 25 });
		servers.push(server);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), server.baseURL);

		await Promise.all([resolveLocalModelsForUser(locals), resolveLocalModelsForUser(locals)]);

		expect(server.callCount()).toBe(1);
	});
});

describe("prewarmLocalModel / prewarmLocalModelForUser — Ollama keep_alive preload (CUR-1194)", () => {
	let servers: Array<{ close: () => Promise<void> }> = [];

	beforeEach(async () => {
		gateMock.enabled = true;
		await cleanupTestData();
		servers = [];
	}, 20000);

	afterEach(async () => {
		await Promise.all(servers.map((s) => s.close()));
	});

	it("prewarmLocalModel hits the NATIVE /api/generate with keep_alive: -1 and no prompt", async () => {
		const server = startRecordingServer();
		servers.push(server);

		prewarmLocalModel(`${server.nativeBaseURL}/v1`, "llama3.2:latest");

		// Fire-and-forget: give the in-flight request a moment to land before asserting.
		await new Promise((r) => setTimeout(r, 50));

		expect(server.requests).toHaveLength(1);
		expect(server.requests[0].method).toBe("POST");
		expect(server.requests[0].url).toBe("/api/generate");
		const body = JSON.parse(server.requests[0].body);
		expect(body).toEqual({ model: "llama3.2:latest", keep_alive: -1 });
	});

	it("prewarmLocalModel strips only the trailing /v1 — the native API has no /v1 of its own", async () => {
		const server = startRecordingServer();
		servers.push(server);

		// No trailing /v1 at all — must still land on /api/generate, not double-strip or 404.
		prewarmLocalModel(server.nativeBaseURL, "llama3.2:latest");
		await new Promise((r) => setTimeout(r, 50));

		expect(server.requests).toHaveLength(1);
		expect(server.requests[0].url).toBe("/api/generate");
	});

	it("CUR-1291: prewarmLocalModel sends the given headers on the preload request", async () => {
		const server = startRecordingServer();
		servers.push(server);

		prewarmLocalModel(`${server.nativeBaseURL}/v1`, "llama3.2:latest", {
			Authorization: "Bearer test-token",
		});
		await new Promise((r) => setTimeout(r, 50));

		expect(server.requests).toHaveLength(1);
		expect(server.requests[0].headers.authorization).toBe("Bearer test-token");
	});

	it("prewarmLocalModel never throws when the target refuses the connection outright", () => {
		// Port 1 is a real, always-refused port — a genuine connection failure, not a mock. The whole
		// point is this is fire-and-forget: a synchronous call must not throw even though the request
		// underneath will fail.
		expect(() => prewarmLocalModel("http://127.0.0.1:1/v1", "llama3.2:latest")).not.toThrow();
	});

	it("prewarmLocalModelForUser prewarms the caller's own endpoint for a matching local id", async () => {
		const server = startRecordingServer();
		servers.push(server);

		const { user, locals } = await createTestUser();
		const endpointId = await insertLocalEndpoint(user._id.toString(), `${server.nativeBaseURL}/v1`);

		await prewarmLocalModelForUser(locals, `${LOCAL_MODEL_ID_PREFIX}${endpointId}:llama3.2:latest`);
		await new Promise((r) => setTimeout(r, 50));

		expect(server.requests).toHaveLength(1);
		expect(server.requests[0].url).toBe("/api/generate");
		expect(JSON.parse(server.requests[0].body)).toEqual({
			model: "llama3.2:latest",
			keep_alive: -1,
		});
	});

	it("CUR-1291: prewarmLocalModelForUser sends the endpoint's stored custom headers", async () => {
		const server = startRecordingServer();
		servers.push(server);

		const { user, locals } = await createTestUser();
		const endpointId = await insertLocalEndpoint(user._id.toString(), `${server.nativeBaseURL}/v1`, {
			headers: [{ name: "Authorization", value: "Bearer test-token" }],
		});

		await prewarmLocalModelForUser(locals, `${LOCAL_MODEL_ID_PREFIX}${endpointId}:llama3.2:latest`);
		await new Promise((r) => setTimeout(r, 50));

		expect(server.requests).toHaveLength(1);
		expect(server.requests[0].headers.authorization).toBe("Bearer test-token");
	});

	it("prewarmLocalModelForUser no-ops (no DB lookup, no network) for a non-local model id", async () => {
		const server = startRecordingServer();
		servers.push(server);

		const { locals } = await createTestUser();
		// No row inserted at all — if this reached the DB it would find nothing anyway, but the point is
		// it must not even try for an ordinary catalog id.
		await prewarmLocalModelForUser(locals, "swiss-ai/apertus-v1.5-70b");
		await new Promise((r) => setTimeout(r, 50));

		expect(server.requests).toHaveLength(0);
	});

	it("prewarmLocalModelForUser no-ops for a DIFFERENT user's local endpoint — ownership, not just id shape", async () => {
		const server = startRecordingServer();
		servers.push(server);
		const { user: owner } = await createTestUser();
		const ownerEndpointId = await insertLocalEndpoint(owner._id.toString(), `${server.nativeBaseURL}/v1`);

		const { locals } = await createTestUser();

		// A validly-SHAPED local model id (real 24-hex endpoint id, real served model tag) that just
		// happens to name someone else's endpoint — the case that matters is this being rejected on
		// OWNERSHIP, not merely on `parseLocalModelId` failing to recognize the shape at all.
		await prewarmLocalModelForUser(locals, `${LOCAL_MODEL_ID_PREFIX}${ownerEndpointId}:llama3.2:latest`);
		await new Promise((r) => setTimeout(r, 50));

		expect(server.requests).toHaveLength(0);
	});

	it("prewarmLocalModelForUser no-ops when the feature flag is off", async () => {
		gateMock.enabled = false;
		const server = startRecordingServer();
		servers.push(server);

		const { user, locals } = await createTestUser();
		const endpointId = await insertLocalEndpoint(user._id.toString(), `${server.nativeBaseURL}/v1`);

		await prewarmLocalModelForUser(locals, `${LOCAL_MODEL_ID_PREFIX}${endpointId}:llama3.2:latest`);
		await new Promise((r) => setTimeout(r, 50));

		expect(server.requests).toHaveLength(0);
	});

	it("prewarmLocalModelForUser no-ops for undefined/no model id (settings PATCHes that don't touch activeModel)", async () => {
		const server = startRecordingServer();
		servers.push(server);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), `${server.nativeBaseURL}/v1`);

		await prewarmLocalModelForUser(locals, undefined);
		await new Promise((r) => setTimeout(r, 50));

		expect(server.requests).toHaveLength(0);
	});

	it("prewarmLocalModelForUser no-ops for a malformed local-shaped id (bad endpoint-id width, missing separator)", async () => {
		const server = startRecordingServer();
		servers.push(server);

		const { user, locals } = await createTestUser();
		await insertLocalEndpoint(user._id.toString(), `${server.nativeBaseURL}/v1`);

		await prewarmLocalModelForUser(locals, `${LOCAL_MODEL_ID_PREFIX}not-24-hex-chars:llama3.2:latest`);
		await prewarmLocalModelForUser(locals, `${LOCAL_MODEL_ID_PREFIX}llama3.2:latest`);
		await new Promise((r) => setTimeout(r, 50));

		expect(server.requests).toHaveLength(0);
	});
});

describe("normalizeLocalBaseUrl — create-time normalization and the private-address guard", () => {
	afterEach(() => {
		if (savedDeployEnv === undefined) delete process.env.DEPLOY_ENV;
		else process.env.DEPLOY_ENV = savedDeployEnv;
	});

	describe("in local development, where localhost is the visitor's own machine", () => {
		beforeEach(() => {
			process.env.DEPLOY_ENV = "development";
		});

		it("appends /v1 to a bare host:port, matching the settings UI's own placeholder", () => {
			expect(normalizeLocalBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
		});

		it("leaves an already-correct /v1 base alone", () => {
			expect(normalizeLocalBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
		});

		it("strips a trailing slash before deciding whether /v1 is already present", () => {
			expect(normalizeLocalBaseUrl("http://localhost:11434/")).toBe("http://localhost:11434/v1");
			expect(normalizeLocalBaseUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
		});

		it("accepts a LAN address", () => {
			expect(normalizeLocalBaseUrl("http://192.168.1.50:11434")).toBe("http://192.168.1.50:11434/v1");
		});

		it("still rejects the cloud-metadata address, which no local server ever lives at", () => {
			expect(normalizeLocalBaseUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
			expect(isRefusedLocalBaseUrl("http://169.254.169.254")).toBe(true);
		});
	});

	describe.each([["preview"], ["production"], [undefined]])(
		"on a hosted deployment (DEPLOY_ENV=%s), where a private address names our own network",
		(env) => {
			beforeEach(() => {
				if (env === undefined) delete process.env.DEPLOY_ENV;
				else process.env.DEPLOY_ENV = env;
			});

			it.each([
				["http://localhost:11434"],
				["http://app.localhost:11434"],
				["http://127.0.0.1:11434"],
				["http://10.0.0.1:11434"],
				["http://192.168.1.50:11434"],
				["http://169.254.170.2"],
				["http://169.254.169.254"],
				["http://[::ffff:169.254.169.254]"],
				["http://[::1]:11434"],
				["http://2130706433:11434"],
			])("rejects %s and reports it as a refused address", (url) => {
				expect(normalizeLocalBaseUrl(url)).toBeNull();
				expect(isRefusedLocalBaseUrl(url)).toBe(true);
			});

			it("accepts a public https server", () => {
				expect(normalizeLocalBaseUrl("https://ollama.example.com")).toBe("https://ollama.example.com/v1");
			});
		}
	);

	it("rejects a non-URL string, without calling it a refused address", () => {
		expect(normalizeLocalBaseUrl("not a url")).toBeNull();
		expect(isRefusedLocalBaseUrl("not a url")).toBe(false);
	});

	it("rejects a non-http(s) scheme", () => {
		expect(normalizeLocalBaseUrl("file:///etc/passwd")).toBeNull();
		expect(normalizeLocalBaseUrl("ftp://example.com")).toBeNull();
	});
});
