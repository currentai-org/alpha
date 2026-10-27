import { describe, it, expect, vi, beforeEach } from "vitest";

const logError = vi.fn();
const logWarn = vi.fn();
const logInfo = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: { error: logError, warn: logWarn, info: logInfo },
}));

// Every test dynamically imports localStore AFTER its own vi.doMock calls, with modules reset in
// between — the model-identity/empty-index/dim-mismatch cases each need a DIFFERENT env/data shape,
// and a single top-level vi.mock would apply file-wide and make the other branches unreachable. This
// also gives each test a fresh copy of the module-level warnedEmptyIndex/warnedModelMismatch flags
// (CUR-879's warn-once-per-process state), which a shared module instance would leak across tests.
beforeEach(() => {
	logError.mockClear();
	logWarn.mockClear();
	logInfo.mockClear();
	// vi.doMock registrations OUTLIVE vi.resetModules() — it only clears the cached module instances,
	// not which mock factory the next import of a given specifier resolves to. Without unmocking here,
	// one test's vi.doMock("./env", ...) silently keeps applying to every later test's fresh import.
	vi.doUnmock("./env");
	vi.doUnmock("./data/rag-index.json");
	vi.doUnmock("./catalogEntitiesFile");
	vi.doUnmock("./embed");
	vi.resetModules();
});

describe("localStore — model-identity guard", () => {
	it("the committed index is non-empty (sanity)", async () => {
		const { localStoreReady } = await import("./localStore");
		expect(localStoreReady()).toBe(true);
	});

	// Model-identity guard: the committed index was built with all-MiniLM-L6-v2. Forcing
	// embeddingModel() to return a DIFFERENT id must make queryLocalStore skip the store entirely
	// — BEFORE it calls embedText — so a same-dimension index from a different model can never
	// produce silently-wrong cosine hits. The mock also means this test makes no network call.
	it("skips retrieval and logs once per process when the active embedding model != the index's model (CUR-879)", async () => {
		vi.doMock("./env", async (importOriginal) => {
			const actual = await importOriginal<typeof import("./env")>();
			return { ...actual, embeddingModel: () => "some/other-embedding-model" };
		});
		const { queryLocalStore } = await import("./localStore");

		await expect(queryLocalStore("open-source AI inference infrastructure")).resolves.toEqual([]);
		expect(logError).toHaveBeenCalledTimes(1);
		expect(logError.mock.calls[0][1]).toMatch(/different embedding model/i);
		expect(logError.mock.calls[0][0]).toMatchObject({ indexModel: expect.any(String) });

		// A second call in the SAME process must not warn again — the mismatch is a static fact, not
		// a per-turn event, and a real production turn happens far more than once.
		await queryLocalStore("a different query");
		expect(logError).toHaveBeenCalledTimes(1);
	});
});

describe("localStore — empty index (CUR-879)", () => {
	it("returns [] and logs once per process when the committed index has no chunks", async () => {
		vi.doMock("./data/rag-index.json", () => ({
			default: { model: "m", dim: 3, builtAt: "2026-01-01T00:00:00Z", chunks: [] },
		}));
		const { queryLocalStore } = await import("./localStore");

		await expect(queryLocalStore("anything")).resolves.toEqual([]);
		expect(logError).toHaveBeenCalledTimes(1);
		expect(logError.mock.calls[0][1]).toMatch(/index is empty/i);

		await queryLocalStore("something else");
		expect(logError).toHaveBeenCalledTimes(1); // warn-once, same as the model-mismatch branch
	});
});

describe("localStore — per-query embedding failures (CUR-879)", () => {
	it("warns (not error — a live per-call event, not a static config fact) when the query embedding call fails", async () => {
		vi.doMock("./embed", () => ({ embedText: vi.fn().mockResolvedValue(null) }));
		const { queryLocalStore } = await import("./localStore");

		await expect(queryLocalStore("anything")).resolves.toEqual([]);
		expect(logWarn).toHaveBeenCalledTimes(1);
		expect(String(logWarn.mock.calls[0][0])).toMatch(/embedding failed/i);
	});

	it("warns when the query embedding's dimension does not match the index", async () => {
		vi.doMock("./embed", () => ({ embedText: vi.fn().mockResolvedValue([0.1, 0.2]) }));
		const { queryLocalStore } = await import("./localStore");

		await expect(queryLocalStore("anything")).resolves.toEqual([]);
		expect(logWarn).toHaveBeenCalledTimes(1);
		expect(logWarn.mock.calls[0][1]).toMatch(/dimension does not match/i);
		expect(logWarn.mock.calls[0][0]).toMatchObject({ queryDim: 2 });
	});
});

describe("localStore — catalog entity chunks (CUR-888)", () => {
	// A three-dimension index with one category chunk and an entity file with one product, so the
	// query vector decides which one ranks first.
	function mockStore(entityModel: string) {
		vi.doMock("./env", async (importOriginal) => {
			const actual = await importOriginal<typeof import("./env")>();
			return { ...actual, embeddingModel: () => "m", localMinScore: () => 0.1, localTopK: () => 5 };
		});
		vi.doMock("./data/rag-index.json", () => ({
			default: {
				model: "m",
				dim: 3,
				builtAt: "2026-01-01T00:00:00Z",
				chunks: [{ id: "category:x", source: "categories", title: "A category", text: "c", vector: [0, 1, 0] }],
			},
		}));
		vi.doMock("./catalogEntitiesFile", () => ({
			readCatalogEntities: async () => ({
				model: entityModel,
				dim: 3,
				builtAt: "2026-01-01T00:00:00Z",
				publishedAt: null,
				chunks: [
					{
						id: "product:apertus",
						source: "catalog",
						title: "Apertus",
						url: "/product/apertus",
						text: "Apertus (by Swiss AI Initiative), catalog entry under Base models: an open LLM.",
						vector: [1, 0, 0],
					},
				],
			}),
		}));
		vi.doMock("./embed", async (importOriginal) => ({
			...(await importOriginal<typeof import("./embed")>()),
			embedText: vi.fn().mockResolvedValue([1, 0, 0]),
		}));
	}

	it("cites the catalog product a query is nearest with a link to that product's page", async () => {
		mockStore("m");
		const { queryLocalStore } = await import("./localStore");

		const [top] = await queryLocalStore("what is apertus");
		expect(top).toMatchObject({ title: "Apertus", url: "/product/apertus" });
	});

	it("leaves entity chunks out of the ranking, and says so, when they were embedded with another model", async () => {
		mockStore("some/other-embedding-model");
		const { queryLocalStore } = await import("./localStore");

		const results = await queryLocalStore("what is apertus");
		expect(results.map((r) => r.url)).not.toContain("/product/apertus");
		expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ usable: false }), expect.any(String));
	});
});

describe("localStore — authored and catalog chunks rank in separate top-Ks (CUR-2429)", () => {
	// Six catalog entities all nearer the query than the one authored chunk. Ranked as one pool with
	// K=5, the authored chunk is sixth and never returned.
	it("returns the nearest authored chunk even when more than K catalog entities outscore it", async () => {
		vi.doMock("./env", async (importOriginal) => {
			const actual = await importOriginal<typeof import("./env")>();
			return { ...actual, embeddingModel: () => "m", localMinScore: () => 0.1, localTopK: () => 5 };
		});
		vi.doMock("./data/rag-index.json", () => ({
			default: {
				model: "m",
				dim: 2,
				builtAt: "2026-01-01T00:00:00Z",
				chunks: [{ id: "project:about", source: "project", title: "AI Potluck", text: "about us", vector: [0.6, 0.8] }],
			},
		}));
		vi.doMock("./catalogEntitiesFile", () => ({
			readCatalogEntities: async () => ({
				model: "m",
				dim: 2,
				builtAt: "2026-01-01T00:00:00Z",
				publishedAt: null,
				chunks: Array.from({ length: 6 }, (_, i) => ({
					id: `product:p${i}`,
					source: "catalog",
					title: `Product ${i}`,
					url: `/product/p${i}`,
					text: `Product ${i} (by Someone), catalog entry under X: a product.`,
					vector: [1, 0.01 * i],
				})),
			}),
		}));
		vi.doMock("./embed", async (importOriginal) => ({
			...(await importOriginal<typeof import("./embed")>()),
			embedText: vi.fn().mockResolvedValue([1, 0]),
		}));
		const { queryLocalStore } = await import("./localStore");

		const results = await queryLocalStore("who runs this");
		expect(results.map((r) => r.title)).toContain("AI Potluck");
		// Five catalog entities still come back alongside it, ordered by score with it.
		expect(results.filter((r) => r.url?.startsWith("/product/"))).toHaveLength(5);
		expect(results.map((r) => r.score)).toEqual([...results.map((r) => r.score)].sort((a, b) => (b ?? 0) - (a ?? 0)));
	});
});
