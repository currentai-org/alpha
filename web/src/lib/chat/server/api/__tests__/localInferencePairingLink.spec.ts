/**
 * The CLI's one-click pairing, through the real page load, form action and poll route,
 * against the real database. Pangolin is the only thing replaced: its client module answers locally,
 * so provisioning itself (managedInference/provision.ts) runs unmodified.
 *
 * The contracts: a link opened from outside the browser pairs on load; any other arrival pairs only on
 * a confirm click; one link provisions one device; the poll hands out the install flags once; and the
 * manual Pair button keeps working beside it. (CUR-4110)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import superjson from "superjson";
import { createTestLocals, createTestUser, cleanupTestData } from "./testHelpers";
import { listLocalEndpointsForUserId } from "$lib/chat/server/db/localInferenceEndpoints";
import { labelFromLink } from "$lib/chat/server/managedInference/pairingLink";

import { load, actions } from "../../../../../routes/chat/local-inference/pair/+page.server";
import { GET as poll } from "../../../../../routes/chat/api/v2/local-inference/pairings/[pairingId]/+server";
import { POST as pairManually } from "../../../../../routes/chat/api/v2/user/local-inference-endpoints/managed/+server";

const gates = vi.hoisted(() => ({ local: true, managedFlag: true, pangolinConfigured: true }));
vi.mock("$lib/chat/server/localEndpointsGate", () => ({
	localInferenceEndpointsEnabled: () => gates.local,
}));
vi.mock("$lib/chat/server/managedInferenceGate", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/managedInferenceGate")>()),
	managedLocalInferenceEndpointsEnabled: () => gates.managedFlag,
	managedInferenceEnabled: () => gates.managedFlag && gates.pangolinConfigured,
	pangolinTunnelEndpoint: () => "https://tunnel.example",
	pangolinDomainId: () => "dom-1",
}));

const pangolin = vi.hoisted(() => {
	let n = 0;
	return {
		failNext: false,
		reset: () => {
			n = 0;
		},
		pickSiteDefaults: vi.fn(async () => {
			n++;
			return {
				exitNodeId: 1,
				address: "100.89.128.1/24",
				publicKey: "pk",
				name: "site",
				listenPort: 51820,
				endpoint: "e",
				subnet: "100.89.128.0/24",
				newtId: `newt-${n}`,
				newtSecret: `secret-${n}`,
			};
		}),
		createSite: vi.fn(async (defaults: { newtId: string }) => ({
			siteId: n,
			niceId: defaults.newtId,
			online: false,
			type: "newt",
		})),
		listDomains: vi.fn(async () => [{ domainId: "dom-1", baseDomain: "tunnel.example" }]),
		createPublicResource: vi.fn(async (_label: string, subdomain: string, domainId: string) => ({
			resourceId: n,
			niceId: subdomain,
			fullDomain: `${subdomain}.tunnel.example`,
			domainId,
		})),
		createTarget: vi.fn(async () => {}),
		createResourceAccessToken: vi.fn(async () => ({ accessTokenId: `tok-${n}`, accessToken: `tokval-${n}` })),
	};
});
vi.mock("$lib/chat/server/managedInference/pangolinClient", () => ({
	pickSiteDefaults: () => {
		if (pangolin.failNext) {
			pangolin.failNext = false;
			return Promise.reject(new Error("Pangolin API GET /pick-site-defaults failed: 502"));
		}
		return pangolin.pickSiteDefaults();
	},
	createSite: pangolin.createSite,
	listDomains: pangolin.listDomains,
	createPublicResource: pangolin.createPublicResource,
	createTarget: pangolin.createTarget,
	createResourceAccessToken: pangolin.createResourceAccessToken,
}));

const PAIRING_ID = "cli-generated-pairing-id-0123456789abcdef";

function pairUrl(id = PAIRING_ID, name: string | null = "Workstation"): URL {
	const url = new URL("http://localhost/chat/local-inference/pair");
	url.searchParams.set("id", id);
	if (name !== null) url.searchParams.set("name", name);
	return url;
}

/** SvelteKit's error()/redirect() throw; real routing turns them into responses. */
async function settle<T>(fn: () => T | Promise<T>): Promise<T | { thrown: { status?: number; location?: string } }> {
	try {
		return await fn();
	} catch (e) {
		return { thrown: e as { status?: number; location?: string } };
	}
}

function visit(locals: App.Locals, opts: { url?: URL; secFetchSite?: string | null } = {}) {
	const url = opts.url ?? pairUrl();
	const headers = new Headers();
	const site = opts.secFetchSite === undefined ? "none" : opts.secFetchSite;
	if (site !== null) headers.set("sec-fetch-site", site);
	const request = new Request(url, { headers });
	return settle(() => load({ locals, url, request } as never));
}

function confirm(locals: App.Locals, url = pairUrl()) {
	const request = new Request(url, { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
	return settle(() => actions.default({ locals, url, request } as never));
}

async function collect(id = PAIRING_ID): Promise<{ status: number; body: unknown; cacheControl: string | null }> {
	const res = await settle(() => poll({ params: { pairingId: id } } as never));
	if ("thrown" in res) return { status: res.thrown.status ?? 500, body: undefined, cacheControl: null };
	return { status: res.status, body: await res.json(), cacheControl: res.headers.get("cache-control") };
}

async function signedIn() {
	const { user, locals } = await createTestUser();
	return { locals, userId: user._id.toString() };
}

describe("CLI pairing link — CUR-4110", () => {
	beforeEach(async () => {
		gates.local = true;
		gates.managedFlag = true;
		gates.pangolinConfigured = true;
		pangolin.failNext = false;
		pangolin.reset();
		vi.clearAllMocks();
		await cleanupTestData();
	});

	describe("the pairing page", () => {
		it("404s while the managed flag is off, before asking anyone to sign in", async () => {
			gates.managedFlag = false;
			expect(await visit(createTestLocals())).toEqual({ thrown: expect.objectContaining({ status: 404 }) });
			gates.managedFlag = true;
			gates.local = false;
			expect(await visit(createTestLocals())).toEqual({ thrown: expect.objectContaining({ status: 404 }) });
		});

		it("sends a signed-out visitor to sign-in with the whole link, id and name, as where to come back to", async () => {
			const result = await visit(createTestLocals());
			expect(result).toEqual({ thrown: expect.objectContaining({ status: 302 }) });
			const location = (result as { thrown: { location: string } }).thrown.location;
			const next = new URL(location, "http://localhost").searchParams.get("next");
			expect(next).toBe(`/chat/local-inference/pair?id=${PAIRING_ID}&name=Workstation`);
		});

		it("refuses a link whose id is too short to be a secret, and provisions nothing", async () => {
			const { locals, userId } = await signedIn();
			expect(await visit(locals, { url: pairUrl("short-id") })).toEqual({ state: "invalid" });
			expect(await listLocalEndpointsForUserId(userId)).toEqual([]);
		});

		it("pairs on load when the link was opened from outside the browser (Sec-Fetch-Site: none)", async () => {
			const { locals, userId } = await signedIn();
			expect(await visit(locals)).toEqual({ state: "paired", label: "Workstation" });

			const rows = await listLocalEndpointsForUserId(userId);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ label: "Workstation", kind: "managed" });
		});

		it.each([["cross-site"], ["same-site"], ["same-origin"], [null]])(
			"asks for a confirm click, provisioning nothing, when Sec-Fetch-Site is %s (a web page could have started it)",
			async (secFetchSite) => {
				const { locals, userId } = await signedIn();
				expect(await visit(locals, { secFetchSite })).toEqual({ state: "confirm", label: "Workstation" });
				expect(await listLocalEndpointsForUserId(userId)).toEqual([]);
				expect(pangolin.pickSiteDefaults).not.toHaveBeenCalled();
				expect((await collect()).body).toEqual({});
			}
		);

		it("keeps showing a finished pairing when the page's data reloads same-origin (hydration, Back), never a confirm button", async () => {
			const { locals } = await signedIn();
			await visit(locals);
			expect(await visit(locals, { secFetchSite: "same-origin" })).toEqual({ state: "paired", label: "Workstation" });
			expect(await visit(locals, { secFetchSite: null })).toEqual({ state: "paired", label: "Workstation" });
		});

		it("a same-origin reload of someone else's pairing still says taken, not confirm", async () => {
			const owner = await signedIn();
			const other = await signedIn();
			await visit(owner.locals);
			expect(await visit(other.locals, { secFetchSite: "same-origin" })).toEqual({ state: "taken" });
		});

		it("pairs when the person confirms", async () => {
			const { locals, userId } = await signedIn();
			expect(await confirm(locals)).toEqual({ state: "paired", label: "Workstation" });
			expect(await listLocalEndpointsForUserId(userId)).toHaveLength(1);
		});

		it("a reload or a second confirm of the same link provisions no second device", async () => {
			const { locals, userId } = await signedIn();
			await visit(locals);
			expect(await visit(locals)).toEqual({ state: "paired", label: "Workstation" });
			expect(await confirm(locals)).toEqual({ state: "paired", label: "Workstation" });
			expect(await listLocalEndpointsForUserId(userId)).toHaveLength(1);
			expect(pangolin.createSite).toHaveBeenCalledTimes(1);
		});

		it("another account opening a link someone already used is told so and gets no device", async () => {
			const owner = await signedIn();
			const other = await signedIn();
			await visit(owner.locals);
			expect(await visit(other.locals)).toEqual({ state: "taken" });
			expect(await listLocalEndpointsForUserId(other.userId)).toEqual([]);
		});

		it("a failed provision says so and leaves the link usable for a retry", async () => {
			const { locals, userId } = await signedIn();
			pangolin.failNext = true;
			expect(await visit(locals)).toEqual({ state: "failed" });
			expect(await listLocalEndpointsForUserId(userId)).toEqual([]);
			expect((await collect()).body).toEqual({});

			expect(await visit(locals)).toEqual({ state: "paired", label: "Workstation" });
		});

		it("reports pairing unavailable when Pangolin isn't configured, instead of failing mid-provision", async () => {
			const { locals, userId } = await signedIn();
			gates.pangolinConfigured = false;
			expect(await visit(locals)).toEqual({ state: "unavailable" });
			expect(await listLocalEndpointsForUserId(userId)).toEqual([]);
		});

		it("names a device from a link with no name the way the settings form would", async () => {
			const { locals, userId } = await signedIn();
			await visit(locals, { url: pairUrl(PAIRING_ID, null) });
			const [row] = await listLocalEndpointsForUserId(userId);
			expect(row.label).toMatch(/^\p{Lu}\p{Ll}+ \p{Lu}\p{Ll}+$/u);
		});
	});

	describe("labelFromLink", () => {
		it("drops control characters, collapses whitespace and caps at 100 characters", () => {
			expect(labelFromLink("  My\u0000 \n Laptop​  ")).toBe("My Laptop");
			expect(labelFromLink("x".repeat(150))).toHaveLength(100);
		});

		it("falls back to a generated name when nothing printable is left", () => {
			expect(labelFromLink("\u0000\u0007  ")).not.toBe("");
			expect(labelFromLink(null)).not.toBe("");
		});
	});

	describe("the CLI's poll", () => {
		it("answers {} until the visit, then the endpoint and install flags exactly once, then {} again", async () => {
			const { locals, userId } = await signedIn();
			expect(await collect()).toEqual({ status: 200, body: {}, cacheControl: "no-store" });

			await visit(locals);
			const [row] = await listLocalEndpointsForUserId(userId);
			const first = await collect();
			expect(first).toEqual({
				status: 200,
				cacheControl: "no-store",
				body: {
					id: row.id,
					label: "Workstation",
					installArgs: { tunnelId: "newt-1", tunnelSecret: "secret-1", tunnelEndpoint: "https://tunnel.example" },
				},
			});

			expect((await collect()).body).toEqual({});
		});

		it("400s an id too short to be the CLI's secret rather than looking it up", async () => {
			expect((await collect("short")).status).toBe(400);
		});

		it("still hands over a parked pairing when the flags read off for the anonymous CLI, since they are account-scoped", async () => {
			const { locals } = await signedIn();
			await visit(locals);
			gates.managedFlag = false;
			gates.local = false;
			expect((await collect()).body).toMatchObject({ label: "Workstation" });
		});
	});

	describe("the manual Pair button, beside it", () => {
		it("still provisions and returns the install flags in its own response", async () => {
			const { locals, userId } = await signedIn();
			const res = await pairManually({
				locals,
				request: new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ label: "Desk" }) }),
			} as never);
			expect(res.status).toBe(201);
			const body = superjson.parse<{ id: string; label: string; installArgs: Record<string, string> }>(await res.text());
			expect(body.label).toBe("Desk");
			expect(body.installArgs).toEqual({ tunnelId: "newt-1", tunnelSecret: "secret-1", tunnelEndpoint: "https://tunnel.example" });

			const rows = await listLocalEndpointsForUserId(userId);
			expect(rows).toHaveLength(1);
			expect(rows[0].headers).toEqual([
				{ name: "P-Access-Token-Id", value: "tok-1" },
				{ name: "P-Access-Token", value: "tokval-1" },
			]);
		});
	});
});
