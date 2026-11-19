/**
 * a signed-in account's local inference endpoints are bounded. The real routes, the real
 * provisioning code and the real shared limiter run; the endpoint table and the limiter's event
 * window are in-memory stand-ins for the database, and Pangolin is a set of spies.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import superjson from "superjson";

type Row = {
	id: string;
	userId: string;
	label: string;
	baseUrl: string;
	headers: { name: string; value: string }[];
	kind: "direct" | "managed";
	managedConfig: unknown;
	createdAt: Date;
};
const rows = vi.hoisted(() => [] as Row[]);
const events = vi.hoisted(() => [] as { type: string; userId?: unknown; ipHash?: string; expiresAt: number }[]);

vi.mock("$lib/chat/server/db/localInferenceEndpoints", () => ({
	listLocalEndpointsForUserId: async (userId: string) => rows.filter((r) => r.userId === userId),
	getLocalEndpointForUserAndId: async (userId: string, id: string) =>
		rows.find((r) => r.userId === userId && r.id === id) ?? null,
	createLocalEndpoint: async (input: Partial<Row> & { userId: string; label: string; baseUrl: string }) => {
		const row: Row = {
			headers: [],
			kind: "direct",
			managedConfig: null,
			...input,
			id: `ep-${rows.length + 1}`,
			createdAt: new Date(),
		};
		rows.push(row);
		return row;
	},
}));

const matches = (key: { type: string; userId?: unknown; ipHash?: string }) => (e: (typeof events)[number]) =>
	e.type === key.type &&
	(key.userId === undefined || String(e.userId) === String(key.userId)) &&
	(key.ipHash === undefined || e.ipHash === key.ipHash) &&
	e.expiresAt > Date.now();
vi.mock("$lib/chat/server/db/eventWindow", () => ({
	countLiveEvents: async (key: { type: string }) => events.filter(matches(key)).length,
	secondsUntilRoom: async () => 1,
	recordEvent: async (key: { type: string; userId?: unknown; ipHash?: string }, windowMs: number) => {
		events.push({ ...key, expiresAt: Date.now() + windowMs });
	},
	recordEvents: async () => {},
}));
vi.mock("$lib/chat/server/alerting", () => ({ recordRateLimitTrip: async () => {} }));
vi.mock("$lib/chat/server/localEndpointsGate", () => ({ localInferenceEndpointsEnabled: () => true }));
vi.mock("$lib/chat/server/managedInferenceGate", () => ({
	managedInferenceEnabled: () => true,
	pangolinDomainId: () => "dom-1",
	pangolinTunnelEndpoint: () => "https://tunnel.example",
}));
const pangolin = vi.hoisted(() => ({
	pickSiteDefaults: vi.fn(async () => ({ newtId: "n", newtSecret: "s", clientAddress: "100.90.0.2" })),
	createSite: vi.fn(async () => ({ siteId: 7, niceId: "nice-7" })),
	listDomains: vi.fn(async () => [{ domainId: "dom-1", baseDomain: "example.org" }]),
	createPublicResource: vi.fn(async () => ({ resourceId: 9, fullDomain: "r9.example.org" })),
	createTarget: vi.fn(async () => {}),
	createResourceAccessToken: vi.fn(async () => ({ accessTokenId: "tid", accessToken: "tok" })),
	getSiteStatus: vi.fn(async () => ({ online: false })),
}));
vi.mock("$lib/chat/server/managedInference/pangolinClient", () => ({
	...pangolin,
	PangolinApiError: class extends Error {},
}));
vi.mock("$lib/chat/server/localModels", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/localModels")>()),
	checkLocalEndpointModels: async () => ["m1"],
}));

import { POST as createDirect } from "../../../routes/chat/api/v2/user/local-inference-endpoints/+server";
import { POST as createManaged } from "../../../routes/chat/api/v2/user/local-inference-endpoints/managed/+server";
import { GET as status } from "../../../routes/chat/api/v2/user/local-inference-endpoints/[id]/status/+server";
// The caps localEndpointLimits.ts sets; the refusal messages below name them too.
const MAX_DIRECT_ENDPOINTS_PER_ACCOUNT = 5;
// That change set the managed cap to 10 (from 3) and the direct cap to 5 (from 10); both limiters unchanged.
const MAX_MANAGED_ENDPOINTS_PER_ACCOUNT = 10;

let n = 0;
function account(): App.Locals {
	n += 1;
	return { user: { _id: `user-${n}` }, sessionId: `session-${n}` } as unknown as App.Locals;
}

async function call(fn: () => Response | Promise<Response>): Promise<{ status: number; message?: string }> {
	try {
		const res = await fn();
		return { status: res.status };
	} catch (e) {
		const err = e as { status?: number; body?: { message?: string } };
		return { status: err.status ?? 500, message: err.body?.message };
	}
}

const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });
const addDirect = (locals: App.Locals, i: number) =>
	call(() =>
		createDirect({
			locals,
			request: post({ label: `s${i}`, baseUrl: `https://s${i}.example.org/v1` }),
			getClientAddress: () => "203.0.113.5",
		} as never)
	);
const addManaged = (locals: App.Locals, i: number) =>
	call(() =>
		createManaged({ locals, request: post({ label: `m${i}` }), getClientAddress: () => "203.0.113.5" } as never)
	);

describe("local inference endpoint bounds", () => {
	beforeEach(() => {
		rows.length = 0;
		events.length = 0;
		for (const fn of Object.values(pangolin)) fn.mockClear();
	});

	it("refuses a direct endpoint past the per-account cap with 409 and a message, and creates no row", async () => {
		const locals = account();
		for (let i = 0; i < MAX_DIRECT_ENDPOINTS_PER_ACCOUNT; i++) {
			expect((await addDirect(locals, i)).status).toBe(201);
			events.length = 0; // isolate the cap from the create limiter
		}
		const refused = await addDirect(locals, 99);
		expect(refused.status).toBe(409);
		expect(refused.message).toMatch(/up to 5 servers/);
		expect(rows).toHaveLength(MAX_DIRECT_ENDPOINTS_PER_ACCOUNT);
		// Another account is unaffected.
		expect((await addDirect(account(), 0)).status).toBe(201);
	});

	it("refuses a managed endpoint past its cap before any tunnel call is made", async () => {
		const locals = account();
		for (let i = 0; i < MAX_MANAGED_ENDPOINTS_PER_ACCOUNT; i++) {
			expect((await addManaged(locals, i)).status).toBe(201);
			events.length = 0; // isolate the cap from the create limiter
		}
		pangolin.createSite.mockClear();
		pangolin.pickSiteDefaults.mockClear();
		const refused = await addManaged(locals, 99);
		expect(refused.status).toBe(409);
		expect(refused.message).toMatch(/up to 10 managed servers/);
		expect(pangolin.pickSiteDefaults).not.toHaveBeenCalled();
		expect(pangolin.createSite).not.toHaveBeenCalled();
		expect(rows.filter((r) => r.kind === "managed")).toHaveLength(MAX_MANAGED_ENDPOINTS_PER_ACCOUNT);
	});

	it("answers 429 to creates past the hourly limiter, direct and managed together, and saves no row", async () => {
		const locals = account();
		// 10 creates an hour, direct and managed together: 5 managed then 5 direct reach it (one more of
		// either kind is over its cap too, but the limiter runs first, so the answer is still 429).
		for (let i = 0; i < 5; i++) expect((await addManaged(locals, i)).status).toBe(201);
		for (let i = 0; i < 5; i++) expect((await addDirect(locals, i)).status).toBe(201);
		const before = rows.length;
		expect((await addDirect(locals, 50)).status).toBe(429);
		expect(rows).toHaveLength(before);
	});

	it("answers 429 to status checks past the per-minute limiter", async () => {
		const locals = account();
		expect((await addDirect(locals, 0)).status).toBe(201);
		const id = rows[0].id;
		const check = () =>
			call(() => status({ locals, params: { id }, getClientAddress: () => "203.0.113.5" } as never));
		const first = await check();
		expect(first.status).toBe(200);
		for (let i = 1; i < 120; i++) await check();
		expect((await check()).status).toBe(429);
	});

	it("answers a status check with the endpoint's live result while under the limit", async () => {
		const locals = account();
		expect((await addDirect(locals, 0)).status).toBe(201);
		const res = await status({
			locals,
			params: { id: rows[0].id },
			getClientAddress: () => "203.0.113.5",
		} as never);
		expect(superjson.parse(await res.text())).toEqual({ online: true, modelIds: ["m1"] });
	});
});
