import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { backendForDeployment, deploymentBase, deploymentBases, resetGatewayDeployments } = await import(
	"./gatewayDeployments"
);

const GATEWAY = "https://gateway.example/v1";

describe("deploymentBase: the base URL a gateway deployment sends to", () => {
	it("takes the deployment's own api_base when it has one", () => {
		expect(
			deploymentBase({ litellm_params: { model: "openai/x", api_base: "https://api.scaleway.ai/abc/v1" } })
		).toBe("https://api.scaleway.ai/abc/v1");
	});

	it("takes Mistral's own API for LiteLLM's mistral provider with no api_base", () => {
		expect(deploymentBase({ litellm_params: { model: "mistral/mistral-medium-3-5", api_base: null } })).toBe(
			"https://api.mistral.ai/v1"
		);
	});

	it("claims no base for a provider whose region the list does not carry (Bedrock)", () => {
		expect(
			deploymentBase({ litellm_params: { model: "bedrock/mistral.mistral-large-3-675b-instruct" } })
		).toBeUndefined();
	});

	it("keys only deployments with an id and a derivable base", () => {
		const bases = deploymentBases({
			data: [
				{ model_info: { id: "a" }, litellm_params: { model: "mistral/m" } },
				{ model_info: { id: "b" }, litellm_params: { model: "bedrock/m" } },
				{ litellm_params: { model: "mistral/m" } },
			],
		});
		expect([...bases]).toEqual([["a", "https://api.mistral.ai/v1"]]);
	});
});

describe("backendForDeployment: one cached read of the gateway's deployment list", () => {
	beforeEach(() => resetGatewayDeployments());

	const list = { data: [{ model_info: { id: "dep1" }, litellm_params: { model: "mistral/m" } }] };

	it("reads the list once with the caller's authorization, and answers later lookups from the cache", async () => {
		const fetchImpl = vi.fn(async () => Response.json(list));
		const opts = { baseURL: GATEWAY, authorization: "Bearer k", fetchImpl: fetchImpl as unknown as typeof fetch };
		expect(await backendForDeployment("dep1", opts)).toBe("https://api.mistral.ai/v1");
		expect(await backendForDeployment("dep1", opts)).toBe("https://api.mistral.ai/v1");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${GATEWAY}/model/info`);
		expect(init.method).toBe("GET");
		expect(init.headers).toEqual({ authorization: "Bearer k" });
	});

	it("answers undefined, and waits a minute before reading again, when the gateway refuses the list", async () => {
		let now = 0;
		const fetchImpl = vi.fn(async () => new Response("no", { status: 403 }));
		const opts = { baseURL: GATEWAY, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now };
		expect(await backendForDeployment("dep1", opts)).toBeUndefined();
		now = 30_000;
		expect(await backendForDeployment("dep1", opts)).toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		now = 61_000;
		await backendForDeployment("dep1", opts);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("reads nothing for a response with no deployment id", async () => {
		const fetchImpl = vi.fn();
		expect(await backendForDeployment(null, { baseURL: GATEWAY, fetchImpl })).toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
