import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Agent, fetch as undiciFetch } from "undici";

const lane = vi.hoisted(() => ({ baseURL: "" }));
vi.mock("$lib/chat/server/mistralKey", () => ({ mistralChatLane: () => lane }));

import { preconnectRouter, upstreamFetch } from "./upstreamFetch";

// A stand-in router on a raw socket, because Node's own HTTP server always sends a
// `Keep-Alive: timeout=` hint and the real router (an AWS load balancer) sends none: it answers
// `Connection: keep-alive` and holds the socket, which is what leaves undici on its 4 s default.
// It serves an OpenAI-shaped streaming completion and the liveliness route, and records which
// connection each request arrived on.
let server: Server;
let connections = 0;
const requests: { url: string; port: number }[] = [];
let base = "";

const CHUNK = JSON.stringify({
	id: "c1",
	object: "chat.completion.chunk",
	created: 0,
	model: "m",
	choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
});

function respond(socket: Socket, url: string) {
	const body = url === "/health/liveliness" ? "ok" : `data: ${CHUNK}\n\ndata: [DONE]\n\n`;
	const type = url === "/health/liveliness" ? "text/plain" : "text/event-stream";
	socket.write(
		`HTTP/1.1 200 OK\r\ncontent-type: ${type}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: keep-alive\r\n\r\n${body}`
	);
}

beforeAll(async () => {
	server = createServer((socket) => {
		connections++;
		let buffered = Buffer.alloc(0);
		socket.on("data", (data: Buffer) => {
			buffered = Buffer.concat([buffered, data]);
			for (;;) {
				const headerEnd = buffered.indexOf("\r\n\r\n");
				if (headerEnd < 0) return;
				const head = buffered.subarray(0, headerEnd).toString();
				const length = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? 0);
				if (buffered.length < headerEnd + 4 + length) return;
				buffered = buffered.subarray(headerEnd + 4 + length);
				const url = head.split(" ")[1] ?? "";
				requests.push({ url, port: socket.remotePort ?? 0 });
				respond(socket, url);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	lane.baseURL = `${base}/v1`;
});

afterAll(() => {
	server.close();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamOnce(): Promise<string> {
	const { createOpenAIClient } = await import("./openaiClient");
	const client = await createOpenAIClient({ baseURL: `${base}/v1`, apiKey: "k", fetch: upstreamFetch, timeout: 5_000 });
	const stream = await client.chat.completions.create({ model: "m", messages: [{ role: "user", content: "x" }], stream: true });
	let text = "";
	for await (const part of stream) text += part.choices[0]?.delta?.content ?? "";
	return text;
}

describe("upstreamFetch", () => {
	it(
		"two router turns 4.5 s apart share one connection, past undici's 4 s idle default",
		async () => {
			const before = connections;
			expect(await streamOnce()).toBe("hi");
			await pause(4_500);
			expect(await streamOnce()).toBe("hi");
			expect(connections - before).toBe(1);
		},
		15_000
	);

	it(
		"the control: a pool with a 1 s idle timeout opens a second connection for the same gap",
		async () => {
			const agent = new Agent({ keepAliveTimeout: 1_000 });
			const before = connections;
			await (await undiciFetch(`${base}/health/liveliness`, { dispatcher: agent })).text();
			await pause(1_500);
			await (await undiciFetch(`${base}/health/liveliness`, { dispatcher: agent })).text();
			expect(connections - before).toBe(2);
			await agent.close();
		},
		10_000
	);

	it(
		"the turn's model call goes out on the socket the preconnect opened",
		async () => {
			const from = requests.length;
			preconnectRouter();
			await vi.waitFor(() => expect(requests.slice(from).map((r) => r.url)).toContain("/health/liveliness"));
			await pause(50);
			expect(await streamOnce()).toBe("hi");
			const [pre, call] = requests.slice(from);
			expect(call.url).toBe("/v1/chat/completions");
			expect(call.port).toBe(pre.port);
		},
		10_000
	);
});
