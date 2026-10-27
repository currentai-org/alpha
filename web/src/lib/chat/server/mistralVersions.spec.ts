import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfg: Record<string, string | undefined> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { isSameMistralModel, resetMistralVersions } = await import("./mistralVersions");

// La Plateforme's /v1/models, trimmed to the entries that matter.
const MODELS = {
	data: [
		{ id: "mistral-large-latest", name: "mistral-large-2512", aliases: ["mistral-large-2512"] },
		{
			id: "mistral-medium-latest",
			name: "mistral-medium-latest",
			aliases: ["mistral-medium-3-5", "mistral-medium-2604"],
		},
	],
};

function serve(body: unknown, status = 200) {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	resetMistralVersions();
	cfg.MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
	cfg.MISTRAL_API_KEY = "k";
	cfg.MISTRAL_CHAT_BASE_URL = undefined;
	cfg.MISTRAL_CHAT_API_KEY = undefined;
	cfg.MISTRAL_API_KEY_CI = undefined;
	cfg.FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL = undefined;
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("isSameMistralModel", () => {
	it("confirms our pin when Mistral lists it as an alias of what the router asked for", async () => {
		serve(MODELS);
		expect(await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512")).toBe(true);
		expect(await isSameMistralModel("openai/mistral-medium-latest", "mistral-medium-2604")).toBe(true);
	});

	it("refuses our pin once latest names a different version", async () => {
		serve({ data: [{ id: "mistral-large-latest", name: "mistral-large-2602", aliases: ["mistral-large-2602"] }] });
		expect(await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512")).toBe(false);
	});

	it("still credits the pinned id when the list is too slow to wait for, from the dated snapshot", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
			const p = isSameMistralModel("openai/mistral-medium-latest", "mistral-medium-2604");
			await vi.advanceTimersByTimeAsync(2_500);
			expect(await p).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("credits Medium to its pin when the router asks for mistral-medium-3-5 and the list is too slow (CUR-4652)", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
			const p = isSameMistralModel("openai/mistral-medium-3-5", "mistral-medium-2604");
			await vi.advanceTimersByTimeAsync(2_500);
			expect(await p).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("claims nothing for a pin the snapshot does not cover when the list is too slow", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
			const p = isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512");
			await vi.advanceTimersByTimeAsync(2_500);
			expect(await p).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns undefined, claiming nothing, when the list cannot be read", async () => {
		serve({ error: "nope" }, 500);
		expect(await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512")).toBeUndefined();
	});

	// With La Plateforme's key retired, the router's passthrough serves the same list to chat's router key.
	it("confirms our pin from the router's passthrough list when MISTRAL_API_KEY is unset", async () => {
		cfg.MISTRAL_API_KEY = undefined;
		cfg.MISTRAL_CHAT_BASE_URL = "https://router.example.test/v1";
		cfg.MISTRAL_CHAT_API_KEY = "router-key";
		const fetchMock = serve(MODELS);
		expect(await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512")).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://router.example.test/mistral/v1/models");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer router-key");
	});

	// An instance that sends chat through its own adapter, which forwards completions only, needs the
	// list from the router behind it (CUR-3841).
	it("reads the list from the router behind a Folkways adapter lane, not from the adapter", async () => {
		cfg.MISTRAL_API_KEY = undefined;
		cfg.MISTRAL_CHAT_BASE_URL = "https://event.example.test/folkways-adapter/mistral/v1";
		cfg.MISTRAL_CHAT_API_KEY = "router-key";
		cfg.FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL = "https://router.example.test/v1";
		const fetchMock = serve(MODELS);
		expect(await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512")).toBe(true);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://router.example.test/mistral/v1/models");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer router-key");
	});

	it("falls back to La Plateforme when the router refuses the list, so a dead router key alone claims nothing wrong", async () => {
		cfg.MISTRAL_CHAT_BASE_URL = "https://router.example.test/v1";
		cfg.MISTRAL_CHAT_API_KEY = "router-key";
		const fetchMock = vi.fn(async (url: string) =>
			url.startsWith("https://router.example.test")
				? new Response("{}", { status: 403 })
				: new Response(JSON.stringify(MODELS), { status: 200 })
		);
		vi.stubGlobal("fetch", fetchMock);
		expect(await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512")).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.mistral.ai/v1/models");
	});

	it("treats a 200 that lists no models as a failed read and falls back, rather than emptying the table", async () => {
		cfg.MISTRAL_CHAT_BASE_URL = "https://router.example.test/v1";
		cfg.MISTRAL_CHAT_API_KEY = "router-key";
		const fetchMock = vi.fn(async (url: string) =>
			url.startsWith("https://router.example.test")
				? new Response("{}", { status: 200 })
				: new Response(JSON.stringify(MODELS), { status: 200 })
		);
		vi.stubGlobal("fetch", fetchMock);
		expect(await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512")).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("reads only La Plateforme on a per-ticket preview, whose chat lane is La Plateforme on the CI key", async () => {
		vi.stubEnv("VERCEL_GIT_COMMIT_REF", "someone/cur-1-a-ticket-branch");
		cfg.MISTRAL_API_KEY_CI = "ci-key";
		cfg.MISTRAL_CHAT_BASE_URL = "https://router.example.test/v1";
		cfg.MISTRAL_CHAT_API_KEY = "router-key";
		const fetchMock = serve(MODELS);
		expect(await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512")).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.mistral.ai/v1/models");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer ci-key");
	});

	it("claims nothing and calls nothing with neither the router nor La Plateforme configured", async () => {
		cfg.MISTRAL_API_KEY = undefined;
		const fetchMock = serve(MODELS);
		expect(await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512")).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not retry an unreadable list on the next answer, so a Mistral outage delays one answer, not every one", async () => {
		const fetchMock = serve({ error: "nope" }, 500);
		await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512");
		expect(await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512")).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reads the list once per hour, not once per answer", async () => {
		const fetchMock = serve(MODELS);
		await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512");
		await isSameMistralModel("openai/mistral-large-latest", "mistral-large-2512");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
