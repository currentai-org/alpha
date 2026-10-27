import { describe, it, expect, beforeEach, vi } from "vitest";
import superjson from "superjson";
import { createTestLocals, createTestUser, cleanupTestData } from "./testHelpers";
import { createLocalEndpoint } from "$lib/chat/server/db/localInferenceEndpoints";

import { GET, POST } from "../../../../../routes/chat/api/v2/user/local-inference-endpoints/+server";
import { DELETE } from "../../../../../routes/chat/api/v2/user/local-inference-endpoints/[id]/+server";

type Row = {
	id: string;
	label: string;
	baseUrl: string;
	headers: { name: string; value: string }[];
	createdAt: string | Date;
	kind?: "direct" | "managed";
};

// SvelteKit's error() THROWS rather than returning a Response — real routing catches that and maps it
// to an HTTP response, but calling a handler directly (this file's whole approach, matching
// conversations-id.spec.ts's own convention) bypasses that machinery entirely. Every call here goes
// through this wrapper so a thrown `error(status, message)` and a normal `return superjsonResponse(...)`
// look the same to the assertions below.
async function call<T = unknown>(
	fn: () => Response | Promise<Response>
): Promise<{ status: number; body?: T }> {
	try {
		const res = await fn();
		const text = await res.text();
		return { status: res.status, body: text ? (superjson.parse(text) as T) : undefined };
	} catch (e) {
		const err = e as { status?: number; body?: { message?: string } };
		return { status: err.status ?? 500, body: err.body as T | undefined };
	}
}

function list(locals: App.Locals) {
	return call<Row[]>(() => GET({ locals } as never));
}

function create(locals: App.Locals, body: unknown) {
	return call<Row>(() =>
		POST({
			locals,
			request: new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }),
		} as never)
	);
}

function remove(locals: App.Locals, id: string) {
	return call<{ success: boolean }>(() => DELETE({ locals, params: { id } } as never));
}

// This whole feature is gated on localInferenceEndpointsEnabled(), a PostHog flag since CUR-3175
// (localEndpointsGate.spec.ts covers the gate itself in isolation), so these tests drive its answer
// directly: ON by default, OFF where a test says so. Same convention as localModels.spec.ts.
const gateMock = vi.hoisted(() => ({ enabled: true }));
vi.mock("$lib/chat/server/localEndpointsGate", () => ({
	localInferenceEndpointsEnabled: () => gateMock.enabled,
}));

describe("api/v2/user/local-inference-endpoints — CUR-1262", () => {
	beforeEach(async () => {
		gateMock.enabled = true;
		await cleanupTestData();
	});


	describe("GET", () => {
		it("returns an empty list for a user with none configured", async () => {
			const { locals } = await createTestUser();
			const { status, body } = await list(locals);
			expect(status).toBe(200);
			expect(body).toEqual([]);
		});

		it("401s a guest (session only, no signed-in user) — this feature has no guest case", async () => {
			const { status } = await list(createTestLocals());
			expect(status).toBe(401);
		});

		it("404s when the feature flag is off, even for a signed-in user", async () => {
			gateMock.enabled = false;
			const { locals } = await createTestUser();
			const { status } = await list(locals);
			expect(status).toBe(404);
		});

		// The list route's toClientShape() must keep `kind` on every response. Without it a
		// managed row's status dot never renders and the row is excluded from the settings UI's
		// status-polling loop, because every row reads as "direct" (undefined is treated the same as
		// "direct" wherever it is read) on any load except the one right after pairing, where the client
		// appends its own optimistic row with `kind` already set locally.
		it("echoes kind: 'managed' for a managed row, not just right after pairing", async () => {
			const { locals } = await createTestUser();
			await createLocalEndpoint({
				userId: locals.user!._id.toString(),
				label: "nx16g",
				baseUrl: "https://nx16g-d858d1.tunnel.example/v1",
				kind: "managed",
				managedConfig: { provider: "pangolin", siteId: 1, niceId: "abc123", resourceId: "1" },
			});

			const { body } = await list(locals);
			expect(body?.[0]?.kind).toBe("managed");
		});
	});

	describe("POST", () => {
		it("creates a row, normalizing a bare host:port into the OpenAI-compatible /v1 base", async () => {
			const { locals } = await createTestUser();
			const { status, body } = await create(locals, {
				label: "Workstation",
				baseUrl: "http://workstation.example.com:11434",
			});

			expect(status).toBe(201);
			expect(body).toMatchObject({ label: "Workstation", baseUrl: "http://workstation.example.com:11434/v1" });
			expect(body?.id).toEqual(expect.any(String));

			const { body: rows } = await list(locals);
			expect(rows).toHaveLength(1);
			expect(rows?.[0]).toMatchObject({ label: "Workstation", baseUrl: "http://workstation.example.com:11434/v1" });
		});

		it("never echoes userId back to the client", async () => {
			const { locals } = await createTestUser();
			const { body } = await create(locals, { label: "local", baseUrl: "http://ollama.example.com:11434" });
			expect(Object.keys(body ?? {}).sort()).toEqual([
				"baseUrl",
				"createdAt",
				"headers",
				"id",
				"kind",
				"label",
			]);
		});

		it("returns kind so a plain 'direct' add defaults correctly", async () => {
			const { locals } = await createTestUser();
			const { body } = await create(locals, { label: "local", baseUrl: "http://ollama.example.com:11434" });
			expect(body?.kind).toBe("direct");
		});

		it("defaults to an empty headers array when none are given", async () => {
			const { locals } = await createTestUser();
			const { body } = await create(locals, { label: "local", baseUrl: "http://ollama.example.com:11434" });
			expect(body?.headers).toEqual([]);
		});

		it("persists custom headers and returns them on both create and list (CUR-1291)", async () => {
			const { locals } = await createTestUser();
			const { status, body: created } = await create(locals, {
				label: "local",
				baseUrl: "http://ollama.example.com:11434",
				headers: [
					{ name: "Authorization", value: "Bearer secret" },
					{ name: "X-Custom-Flag", value: "" },
				],
			});

			expect(status).toBe(201);
			expect(created?.headers).toEqual([
				{ name: "Authorization", value: "Bearer secret" },
				{ name: "X-Custom-Flag", value: "" },
			]);

			const { body: rows } = await list(locals);
			expect(rows?.[0]?.headers).toEqual([
				{ name: "Authorization", value: "Bearer secret" },
				{ name: "X-Custom-Flag", value: "" },
			]);
		});

		it("trims header name/value whitespace", async () => {
			const { locals } = await createTestUser();
			const { body } = await create(locals, {
				label: "local",
				baseUrl: "http://ollama.example.com:11434",
				headers: [{ name: "  Authorization  ", value: "  Bearer secret  " }],
			});
			expect(body?.headers).toEqual([{ name: "Authorization", value: "Bearer secret" }]);
		});

		it("400s a header with no name", async () => {
			const { locals } = await createTestUser();
			const { status } = await create(locals, {
				label: "local",
				baseUrl: "http://ollama.example.com:11434",
				headers: [{ name: "  ", value: "x" }],
			});
			expect(status).toBe(400);
		});

		it("400s more than 50 headers", async () => {
			const { locals } = await createTestUser();
			const headers = Array.from({ length: 51 }, (_, i) => ({ name: `H-${i}`, value: "x" }));
			const { status } = await create(locals, {
				label: "local",
				baseUrl: "http://ollama.example.com:11434",
				headers,
			});
			expect(status).toBe(400);
		});

		it("allows a SECOND endpoint for the same user — the unique-per-user constraint was relaxed", async () => {
			const { locals } = await createTestUser();
			await create(locals, { label: "Workstation", baseUrl: "http://workstation.example.com:11434" });
			await create(locals, { label: "MacBook", baseUrl: "http://macbook.example.com:8080" });

			const { body: rows } = await list(locals);
			expect(rows).toHaveLength(2);
			expect(rows?.map((r) => r.label).sort()).toEqual(["MacBook", "Workstation"]);
		});

		it("400s a missing label", async () => {
			const { locals } = await createTestUser();
			const { status } = await create(locals, { baseUrl: "http://ollama.example.com:11434" });
			expect(status).toBe(400);
		});

		it("400s a missing baseUrl", async () => {
			const { locals } = await createTestUser();
			const { status } = await create(locals, { label: "local" });
			expect(status).toBe(400);
		});

		it("400s a structurally invalid server URL", async () => {
			const { locals } = await createTestUser();
			const { status } = await create(locals, { label: "local", baseUrl: "not a url" });
			expect(status).toBe(400);
		});

		it("400s the cloud-metadata address", async () => {
			const { locals } = await createTestUser();
			const { status } = await create(locals, { label: "local", baseUrl: "http://169.254.169.254" });
			expect(status).toBe(400);
		});

		// On a hosted deployment a private address names our own network, not the visitor's. (CUR-3387)
		it.each(["http://localhost:11434", "http://192.168.1.50:11434", "http://[::ffff:a9fe:a9fe]"])(
			"400s private address %s on preview and stores nothing, pointing at managed servers",
			async (baseUrl) => {
				const { locals } = await createTestUser();
				const { status, body } = await create(locals, { label: "local", baseUrl });
				expect(status).toBe(400);
				expect((body as unknown as { message: string }).message).toMatch(/managed server/);
				const { body: rows } = await list(locals);
				expect(rows).toEqual([]);
			}
		);

		it("404s when the feature flag is off", async () => {
			gateMock.enabled = false;
			const { locals } = await createTestUser();
			const { status } = await create(locals, { label: "local", baseUrl: "http://ollama.example.com:11434" });
			expect(status).toBe(404);
		});
	});

	describe("DELETE", () => {
		it("removes the caller's own endpoint", async () => {
			const { locals } = await createTestUser();
			const { body: created } = await create(locals, { label: "local", baseUrl: "http://ollama.example.com:11434" });

			const { status } = await remove(locals, created!.id);
			expect(status).toBe(200);

			const { body: rows } = await list(locals);
			expect(rows).toEqual([]);
		});

		it("404s a nonexistent id", async () => {
			const { locals } = await createTestUser();
			const { status } = await remove(locals, "does-not-exist");
			expect(status).toBe(404);
		});

		it("404s a DIFFERENT user's endpoint id, and does NOT delete it", async () => {
			const { locals: ownerLocals } = await createTestUser();
			const { body: created } = await create(ownerLocals, {
				label: "local",
				baseUrl: "http://ollama.example.com:11434",
			});

			const { locals: attackerLocals } = await createTestUser();
			const { status } = await remove(attackerLocals, created!.id);
			expect(status).toBe(404);

			const { body: ownerRows } = await list(ownerLocals);
			expect(ownerRows).toHaveLength(1);
		});

		it("404s when the feature flag is off", async () => {
			const { locals } = await createTestUser();
			const { body: created } = await create(locals, { label: "local", baseUrl: "http://ollama.example.com:11434" });

			gateMock.enabled = false;
			const { status } = await remove(locals, created!.id);
			expect(status).toBe(404);
		});
	});
});
