import { describe, it, expect, vi } from "vitest";
import superjson from "superjson";

// A registry entry shaped like the real ones: the endpoint carries the upstream key. The per-model
// routes must not return this object as-is.
const SECRET = "hf_test_only_not_a_real_key_0000000000";
vi.mock("$lib/chat/server/models", () => {
	const entry = {
		id: "acme/test-model",
		name: "acme/test-model",
		displayName: "Test Model",
		unlisted: false,
		endpoints: [{ type: "openai", baseURL: "https://upstream.invalid/v1", apiKey: SECRET }],
		// The registry schema lets both of these through with `.passthrough()`, so a field the
		// gateway catalog adds per provider, or one set in MODELS overrides, rides along (CUR-2640).
		providers: [{ provider: "acme-host", supports_tools: true, apiKey: SECRET }],
		parameters: { temperature: 0.3, truncate: 4096, upstreamKey: SECRET },
	};
	return { models: [entry], defaultModel: entry };
});
vi.mock("$lib/chat/server/localModels", () => ({
	resolveLocalModelsForUser: async () => [],
	getEffectiveValidModelIdSchema: () => undefined,
}));

const { GET: byNamespace } = await import("../../../../../routes/chat/api/v2/models/[namespace]/+server");
const { GET: byModel } = await import(
	"../../../../../routes/chat/api/v2/models/[namespace]/[model]/+server"
);
const { GET: index } = await import("../../../../../routes/chat/api/v2/models/+server");

// The fields getLayoutModels sends. Anything else on a response is a field nobody chose to publish.
const PUBLIC_FIELDS = new Set([
	"id",
	"name",
	"websiteUrl",
	"modelUrl",
	"datasetName",
	"datasetUrl",
	"displayName",
	// CUR-3037. Only a user's OWN local model carries this, and these routes are per-user and
	// `private`-cached, so it reaches nobody but the person whose endpoint it describes. Recorded
	// here deliberately: this list exists to make a growing payload a decision rather than an
	// accident, and it caught this one.
	"localEndpointKind",
	"description",
	"knownWeakSpot",
	"logoUrl",
	"providers",
	"promptExamples",
	"parameters",
	"preprompt",
	"multimodal",
	"multimodalAcceptedMimetypes",
	"supportsTools",
	"supportsReasoning",
	"supportsArtifacts",
	"unlisted",
	"hasInferenceAPI",
	"isRouter",
]);

function event(params: Record<string, string>) {
	return { params, locals: {} as App.Locals, url: new URL("http://localhost"), request: new Request("http://localhost") };
}

async function body(res: Response) {
	const text = await res.text();
	return { text, data: superjson.parse(text) as Record<string, unknown> | Record<string, unknown>[] };
}

describe("model API routes publish only the allowlisted fields, never endpoints or keys", () => {
	it("GET /api/v2/models/[namespace]/[model] carries no field outside the allowlist", async () => {
		const res = await byModel(event({ namespace: "acme", model: "test-model" }) as never);
		const { text, data } = await body(res);
		expect(Object.keys(data).filter((k) => !PUBLIC_FIELDS.has(k))).toEqual([]);
		expect(text).not.toContain(SECRET);
	});

	it("GET /api/v2/models/[namespace] carries no field outside the allowlist", async () => {
		// A namespace-only id, so register the lookup under the bare namespace too.
		const { models } = await import("$lib/chat/server/models");
		(models as unknown as { id: string }[]).push({ ...(models[0] as object), id: "acme" } as never);
		const res = await byNamespace(event({ namespace: "acme" }) as never);
		const { text, data } = await body(res);
		expect(Object.keys(data).filter((k) => !PUBLIC_FIELDS.has(k))).toEqual([]);
		expect(text).not.toContain(SECRET);
	});

	it("GET /api/v2/models (the list) carries no field outside the allowlist", async () => {
		const res = await index(event({}) as never);
		const { text, data } = await body(res);
		for (const m of data as Record<string, unknown>[]) {
			expect(Object.keys(m).filter((k) => !PUBLIC_FIELDS.has(k))).toEqual([]);
		}
		expect(text).not.toContain(SECRET);
	});

	it("strips fields nested in providers and parameters down to the published shape", async () => {
		const res = await index(event({}) as never);
		const { text, data } = await body(res);
		const model = (data as Record<string, unknown>[]).find((m) => m.id === "acme/test-model");
		expect(model?.providers).toEqual([{ provider: "acme-host", supports_tools: true }]);
		expect(model?.parameters).toEqual({ temperature: 0.3, truncate: 4096 });
		expect(text).not.toContain(SECRET);
	});

	it("an unknown model is a 404, not an empty object", async () => {
		await expect(byModel(event({ namespace: "acme", model: "nope" }) as never)).rejects.toMatchObject({
			status: 404,
		});
	});
});
