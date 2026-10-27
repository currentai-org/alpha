import { describe, it, expect, vi, beforeEach } from "vitest";

// Hermetic: mock the SyftHub client (hub.browse), the env reader, and the logger. No network.
const h = vi.hoisted(() => {
	const browseAll = vi.fn();
	const browse = vi.fn(() => ({ all: browseAll }));
	const loggerWarn = vi.fn();
	return {
		browseAll,
		browse,
		loggerWarn,
		client: { hub: { browse } } as unknown,
		clientRef: { v: null as unknown },
		throwOnClient: { v: false },
		buildKey: { v: "build-1" },
		// getSyftClient may bump the build key (a concurrent rebuild) when this is set.
		buildKeyOnAcquire: { v: "" },
		config: {} as Record<string, unknown>,
		router: {} as Record<string, unknown>,
	};
});

vi.mock("./syftClient", () => ({
	getSyftClient: () => {
		if (h.throwOnClient.v) {
			throw new Error("client construction blew up");
		}
		if (h.buildKeyOnAcquire.v) {
			h.buildKey.v = h.buildKeyOnAcquire.v;
		}
		return h.clientRef.v;
	},
	syftClientBuildKey: () => h.buildKey.v,
}));
vi.mock("./env", () => ({ syft: () => h.config, syftRouter: () => h.router }));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: h.loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getSyftCatalog, _resetCatalogCache } from "./syftCatalog";

const source = (over: Record<string, unknown> = {}) => ({
	ownerUsername: "acme",
	slug: "news",
	name: "Acme News",
	description: "Latest acme headlines",
	tags: [] as string[],
	policies: [] as Array<Record<string, unknown>>,
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	_resetCatalogCache();
	h.clientRef.v = h.client;
	h.throwOnClient.v = false;
	h.buildKey.v = "build-1";
	h.buildKeyOnAcquire.v = "";
	for (const k of Object.keys(h.config)) delete h.config[k];
	Object.assign(h.config, { scopeOwner: "", scopeTag: "", sourceBlocklist: [] });
	for (const k of Object.keys(h.router)) delete h.router[k];
	Object.assign(h.router, { catalogTtlMs: 3600000 });
});

describe("getSyftCatalog", () => {
	it("returns null (and never browses) when no client is configured", async () => {
		h.clientRef.v = null;
		expect(await getSyftCatalog()).toBeNull();
		expect(h.browse).not.toHaveBeenCalled();
	});

	it("returns null when the client acquisition throws (fail-open)", async () => {
		h.throwOnClient.v = true;
		expect(await getSyftCatalog()).toBeNull();
		expect(h.loggerWarn).toHaveBeenCalled();
	});

	it("maps sources to capped entries paired with the build key", async () => {
		h.browseAll.mockResolvedValue([
			source({ ownerUsername: "a", slug: "x", name: "X", description: "desc x", tags: ["t1"] }),
			source({ ownerUsername: "b", slug: "y", name: "Y", description: "desc y" }),
		]);
		const cat = await getSyftCatalog();
		expect(cat?.buildKey).toBe("build-1");
		expect(cat?.entries).toEqual([
			{ path: "a/x", name: "X", description: "desc x", tags: ["t1"], metered: false },
			{ path: "b/y", name: "Y", description: "desc y", tags: [], metered: false },
		]);
		expect(h.browse).toHaveBeenCalledWith(expect.objectContaining({ endpointType: "data_source" }));
	});

	it("derives metered=true from an enabled payment policy / priced config, false otherwise", async () => {
		h.browseAll.mockResolvedValue([
			source({ slug: "pay", policies: [{ type: "mpp_per_request", enabled: true, config: {} }] }),
			source({
				slug: "priced",
				policies: [{ type: "custom", enabled: true, config: { price: 0.1 } }],
			}),
			source({
				slug: "disabled",
				policies: [{ type: "mpp_per_request", enabled: false, config: {} }],
			}),
			source({ slug: "ratelimit", policies: [{ type: "rate_limit", enabled: true, config: {} }] }),
			source({ slug: "free", policies: [] }),
		]);
		const cat = await getSyftCatalog();
		const metered = Object.fromEntries(
			(cat?.entries ?? []).map((e) => [e.path.split("/")[1], e.metered])
		);
		expect(metered).toEqual({
			pay: true,
			priced: true,
			disabled: false,
			ratelimit: false,
			free: false,
		});
	});

	it("caps an abusive name/description so the router prompt can't be blown", async () => {
		h.browseAll.mockResolvedValue([
			source({ name: "N".repeat(5000), description: "D".repeat(5000) }),
		]);
		const cat = await getSyftCatalog();
		expect(cat?.entries[0].name.length ?? 0).toBeLessThanOrEqual(201); // LABEL_CAP + ellipsis
		expect(cat?.entries[0].description.length ?? 0).toBeLessThanOrEqual(301); // desc cap + ellipsis
	});

	it("applies owner + tag scope filters; an empty scoped catalog returns null", async () => {
		h.config.scopeOwner = "ours";
		h.config.scopeTag = "potluck";
		h.browseAll.mockResolvedValue([
			source({ ownerUsername: "ours", slug: "ok", tags: ["potluck"] }),
			source({ ownerUsername: "ours", slug: "notag", tags: ["other"] }),
			source({ ownerUsername: "theirs", slug: "x", tags: ["potluck"] }),
		]);
		const cat = await getSyftCatalog();
		expect(cat?.entries.map((e) => e.path)).toEqual(["ours/ok"]);

		// Scope that matches nothing → empty scoped catalog → null (NOT a cached []).
		_resetCatalogCache();
		h.config.scopeOwner = "nobody";
		expect(await getSyftCatalog()).toBeNull();
	});

	it("drops blocklisted owner/slug paths from the catalog", async () => {
		h.config.sourceBlocklist = ["tempo/news", "tempo/plus"];
		h.browseAll.mockResolvedValue([
			source({ ownerUsername: "tempo", slug: "news" }),
			source({ ownerUsername: "tempo", slug: "plus" }),
			source({ ownerUsername: "epfl-news", slug: "epfl-news" }),
		]);
		const cat = await getSyftCatalog();
		expect(cat?.entries.map((e) => e.path)).toEqual(["epfl-news/epfl-news"]);
	});

	it("returns null when browse throws", async () => {
		h.browseAll.mockRejectedValue(new Error("network"));
		expect(await getSyftCatalog()).toBeNull();
		expect(h.loggerWarn).toHaveBeenCalled();
	});

	it("returns null (and does not cache) when the build key changes DURING browse", async () => {
		h.browseAll.mockImplementation(async () => {
			h.buildKey.v = "build-2"; // a concurrent rebuild lands while browse is in flight
			return [source()];
		});
		expect(await getSyftCatalog()).toBeNull();
		// A second call re-browses (nothing was cached under the stale build).
		h.buildKey.v = "build-2";
		h.browseAll.mockResolvedValue([source()]);
		const cat = await getSyftCatalog();
		expect(cat?.entries).toHaveLength(1);
	});

	it("returns null without caching when the signal is already aborted", async () => {
		h.browseAll.mockResolvedValue([source()]);
		const ctrl = new AbortController();
		ctrl.abort();
		expect(await getSyftCatalog(ctrl.signal)).toBeNull();
		expect(h.browse).not.toHaveBeenCalled();
	});

	it("returns null without caching when aborted mid-browse (soft cap)", async () => {
		const ctrl = new AbortController();
		h.browseAll.mockImplementation(async () => {
			ctrl.abort(); // the preflight child is aborted while the browse resolves
			return [source()];
		});
		expect(await getSyftCatalog(ctrl.signal)).toBeNull();
		// Nothing was cached: a fresh, un-aborted call re-browses and succeeds.
		h.browseAll.mockResolvedValue([source()]);
		const cat = await getSyftCatalog();
		expect(cat?.entries).toHaveLength(1);
	});

	it("caches within TTL: a second call does not re-browse; scope is part of the key", async () => {
		h.browseAll.mockResolvedValue([source()]);
		await getSyftCatalog();
		await getSyftCatalog();
		expect(h.browse).toHaveBeenCalledTimes(1); // served from cache

		h.config.scopeOwner = "ours"; // a different scope key → fresh browse
		h.browseAll.mockResolvedValue([source({ ownerUsername: "ours" })]);
		await getSyftCatalog();
		expect(h.browse).toHaveBeenCalledTimes(2);
	});
});
