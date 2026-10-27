import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { localEndpointFetch, privateLocalAddressesAllowed } from "./localEndpointFetch";
import { endpointOai } from "./endpoints/openai/endpointOai";

// CUR-3387. A user's local inference endpoint URL is user input that our server fetches. Outside local
// development a private address names our host's network, so every request to such an endpoint must
// refuse one: as a typed literal, as a name that resolves to one, and as a redirect target.

// The redirect case needs a public first hop, which a unit test cannot serve over real DNS. undici's
// fetch is swapped only for that case; every other test here uses the real one over real TCP.
const undiciStub = vi.hoisted(() => ({
	impl: null as null | ((url: string, init: unknown) => Promise<Response>),
}));
vi.mock("undici", async (importOriginal) => {
	const actual = await importOriginal<typeof import("undici")>();
	return {
		...actual,
		fetch: (url: string, init: unknown) =>
			undiciStub.impl ? undiciStub.impl(url, init) : (actual.fetch as unknown as (u: string, i: unknown) => Promise<Response>)(url, init),
	};
});

const savedDeployEnv = process.env.DEPLOY_ENV;
function setDeployEnv(value: string | undefined) {
	if (value === undefined) delete process.env.DEPLOY_ENV;
	else process.env.DEPLOY_ENV = value;
}

/** A real server on loopback, standing in for whatever internal service an attacker would aim at.
 *  It answers like an OpenAI-compatible server so the development case has something to reach. */
let server: Server | undefined;
let requests = 0;
async function startLoopbackServer(): Promise<string> {
	requests = 0;
	server = createServer((req, res) => {
		requests++;
		if (req.url?.endsWith("/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "llama3.2" }] }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(
			'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"llama3.2","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
		);
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
	undiciStub.impl = null;
});

afterEach(async () => {
	setDeployEnv(savedDeployEnv);
	if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
});

describe("privateLocalAddressesAllowed", () => {
	it("allows private addresses in local development only", () => {
		setDeployEnv("development");
		expect(privateLocalAddressesAllowed()).toBe(true);
	});

	it.each([["preview"], ["production"], [undefined]])(
		"refuses them on %s, and treats an undeclared environment as hosted (fails closed)",
		(env) => {
			setDeployEnv(env);
			expect(privateLocalAddressesAllowed()).toBe(false);
		}
	);
});

describe("localEndpointFetch outside development refuses every private address (CUR-3387)", () => {
	beforeEach(() => setDeployEnv("preview"));

	it.each([
		["loopback", "http://127.0.0.1:9/v1/models"],
		["RFC1918 10/8", "http://10.0.0.1:9/v1/models"],
		["the container credentials endpoint", "http://169.254.170.2/v1/models"],
		["the IPv4-mapped cloud-metadata address", "http://[::ffff:169.254.169.254]/v1/models"],
		["IPv6 unique local", "http://[fd00::1]:9/v1/models"],
	])("refuses %s before a socket opens", async (_label, url) => {
		await expect(localEndpointFetch(url)).rejects.toThrow(/SSRF|internal/);
	});

	it("refuses a hostname that resolves to loopback, and the server behind it receives nothing", async () => {
		const hostPort = await startLoopbackServer();
		const port = hostPort.split(":")[1];
		await expect(localEndpointFetch(`http://localhost:${port}/v1/models`)).rejects.toThrow();
		expect(requests).toBe(0);
	});

	it("refuses a public URL that redirects to the metadata address, without following the hop", async () => {
		const fetched: string[] = [];
		undiciStub.impl = async (url) => {
			fetched.push(url);
			return new Response(null, {
				status: 302,
				headers: { location: "http://169.254.169.254/latest/meta-data/" },
			});
		};
		await expect(localEndpointFetch("https://models.example.com/v1/models")).rejects.toThrow(
			/unsafe URL blocked/
		);
		expect(fetched).toEqual(["https://models.example.com/v1/models"]);
	});
});

describe("localEndpointFetch in development reaches the visitor's own machine", () => {
	it("fetches a loopback server, as `pnpm dev` against a local Ollama needs", async () => {
		setDeployEnv("development");
		const hostPort = await startLoopbackServer();
		const res = await localEndpointFetch(`http://${hostPort}/v1/models`);
		expect(res.ok).toBe(true);
		expect(requests).toBe(1);
	});
});

describe("the chat turn to a stored local endpoint goes through the guard (rows created before CUR-3387)", () => {
	async function turnAgainst(baseURL: string, routerProvider?: string) {
		const endpoint = await endpointOai({
			type: "openai",
			baseURL,
			apiKey: "sk-local",
			modelId: "llama3.2",
			...(routerProvider ? { routerProvider } : {}),
			model: { id: "local:llama3.2", name: "llama3.2", parameters: {} },
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
		} as Parameters<typeof endpoint>[0]);
		for await (const chunk of stream) void chunk;
	}

	it("refuses a local endpoint whose stored base URL is private, and the server receives nothing", async () => {
		setDeployEnv("preview");
		const hostPort = await startLoopbackServer();
		await expect(turnAgainst(`http://${hostPort}/v1`, "local")).rejects.toThrow();
		expect(requests).toBe(0);
	});

	it("still reaches it in development", async () => {
		setDeployEnv("development");
		const hostPort = await startLoopbackServer();
		await turnAgainst(`http://${hostPort}/v1`, "local");
		expect(requests).toBeGreaterThan(0);
	});
});
