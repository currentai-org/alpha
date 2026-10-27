import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Mistral route in front of chat's Mistral lane. The contract is a proxy's: what
// Mistral streams reaches chat byte for byte (list-shaped `delta.content`, `reference` parts,
// tool-call deltas, the finish chunk, usage), what chat sent reaches Mistral byte for byte with
// chat's own bearer, and Folkways gets a trace without the conversation. The stream fixtures are
// split mid-event so a route that parsed and re-serialized per chunk would not reproduce them. (CUR-3186)

const mockEnv = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>
}));
vi.mock('$env/dynamic/private', () => mockEnv);
vi.mock('$env/static/public', () => ({ PUBLIC_COMMIT_SHA: 'test' }));
vi.mock('$lib/chat/server/flags', () => ({
	ensureFlagsPolled: async () => {},
	flagEnabledOr: () => true
}));
vi.mock('$lib/chat/server/tuning', () => ({ getTuning: async () => ({}) }));
vi.mock('$lib/chat/server/models', () => ({ defaultModel: { id: 'mistral-large-2512' } }));
// Await background work inline so the trace has been posted by the time the handler returns.
vi.mock('$lib/chat/server/vercelBackground', () => ({
	runInBackground: async (p: Promise<unknown>) => {
		await p.catch(() => {});
	}
}));
vi.mock('./safetySnapshot', () => ({
	safetySnapshot: async () => ({
		rules_hash: 'rules-hash',
		detector: 'shieldstral',
		rules_json_enforced: true,
		output_moderation: false
	}),
	safetySignature: () => 'sig'
}));
vi.mock('./promptLoader', () => ({
	loadStablePromptSegments: async () => [],
	stablePromptHash: () => 'stable-hash',
	resolveModelAllowlist: () => ['mistral-large-2512'],
	resolveModelParameters: async () => ({})
}));

import { GET, POST } from './mistral/v1/chat/completions/+server';

const HOST_KEY = 'mk-host-chat';
const MISTRAL = 'https://api.mistral.ai/v1/chat/completions';

// A citation turn: list-shaped content with a text part and a reference part, then a finish chunk
// carrying usage. Split mid-event, mid-JSON.
const CITATION_STREAM = [
	'data: {"id":"a","object":"chat.completion.chunk","model":"mistral-large-2512","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
	'data: {"id":"a","object":"chat.completion.chunk","model":"mistral-large-2512","choices":[{"index":0,"delta":{"content":[{"type":"text","text":"Bern is the capital"},{"type":"reference","reference_ids":[0,2]}]}}]}\n\ndata: {"id":"a","choi',
	'ces":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"total_tokens":131,"completion_tokens":11}}\n\n',
	'data: [DONE]\n\n'
];

// A tool turn: a tool_call delta, then finish_reason tool_calls.
const TOOL_STREAM = [
	'data: {"id":"b","object":"chat.completion.chunk","model":"mistral-large-2512","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
	'data: {"id":"b","object":"chat.completion.chunk","model":"mistral-large-2512","choices":[{"index":0,"delta":{"tool_calls":[{"id":"Xy12abCd9","function":{"name":"calculate","arguments":"{\\"expression\\": \\"17*23\\"}"},"index":0}]}}]}\n\n',
	'data: {"id":"b","object":"chat.completion.chunk","model":"mistral-large-2512","choices":[{"index":0,"delta":{"content":""},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":80,"total_tokens":101,"completion_tokens":21}}\n\n',
	'data: [DONE]\n\n'
];

const sse = (parts: string[], init: ResponseInit = {}) =>
	new Response(
		new ReadableStream({
			start(controller) {
				for (const p of parts) controller.enqueue(new TextEncoder().encode(p));
				controller.close();
			}
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' }, ...init }
	);

type Call = { url: string; init: RequestInit };
let calls: Call[];
let upstream: () => Response;

beforeEach(() => {
	mockEnv.env = {
		OPENAI_API_KEY: 'sk-gateway',
		MISTRAL_CHAT_API_KEY: HOST_KEY,
		FOLKWAYS_URL: 'http://folkways.test'
	};
	calls = [];
	upstream = () => sse(CITATION_STREAM);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url: String(url), init });
			if (String(url).startsWith('http://folkways.test'))
				return new Response('{}', { status: 200 });
			return upstream();
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

// Odd spacing and key order on purpose: a forwarder that re-serialized would change these bytes.
const RAW_BODY =
	'{"model":"mistral-large-2512",  "stream":true,"messages":[{"role":"system","content":"You are Alpha."},{"role":"user","content":"Capital of Switzerland?"}],"tools":[{"type":"function","function":{"name":"calculate","parameters":{"type":"object","properties":{"expression":{"type":"string"}}}}}]}';

const turn = (bearer = HOST_KEY, body = RAW_BODY) =>
	new Request('http://app/folkways-adapter/mistral/v1/chat/completions', {
		method: 'POST',
		headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
		body
	});

const mistralCalls = () => calls.filter((c) => !c.url.startsWith('http://folkways.test'));
const traceCalls = () => calls.filter((c) => c.url === 'http://folkways.test/v1/traces');

describe('Folkways Mistral route: a byte-for-byte proxy that also traces (CUR-3186)', () => {
	it('forwards a list-shaped delta.content with reference parts, the finish chunk and usage unchanged', async () => {
		const res = await POST({ request: turn() });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/event-stream');
		expect(await res.text()).toBe(CITATION_STREAM.join(''));
	});

	it('forwards tool_call deltas and finish_reason tool_calls unchanged', async () => {
		upstream = () => sse(TOOL_STREAM);
		const res = await POST({ request: turn() });
		expect(await res.text()).toBe(TOOL_STREAM.join(''));
	});

	it("sends Mistral the caller's exact request bytes and bearer, at the default upstream", async () => {
		await POST({ request: turn() });
		const [call] = mistralCalls();
		expect(call.url).toBe(MISTRAL);
		expect(call.init.body).toBe(RAW_BODY);
		expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${HOST_KEY}`);
	});

	it('sends to FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL when it is set', async () => {
		mockEnv.env.FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL = 'https://router.example/v1/';
		await POST({ request: turn() });
		expect(mistralCalls()[0].url).toBe('https://router.example/v1/chat/completions');
	});

	it('posts an observe trace for a Mistral turn, naming the lane and carrying no conversation', async () => {
		await POST({ request: turn() });
		const traces = traceCalls();
		expect(traces).toHaveLength(1);
		const payload = JSON.parse(String(traces[0].init.body));
		expect(payload.served_model).toBe('mistral-large-2512');
		expect(payload.release_id).toBe('observe');
		expect(payload.detail).toMatchObject({
			lane: 'mistral',
			mode: 'observe',
			stream: true,
			upstream_status: 200
		});
		expect(String(traces[0].init.body)).not.toContain('Capital of Switzerland');
	});

	it('observes even when FOLKWAYS_MODE=resolve: never calls /v1/resolve and never rewrites the request', async () => {
		mockEnv.env.FOLKWAYS_MODE = 'resolve';
		await POST({ request: turn() });
		expect(calls.some((c) => c.url.endsWith('/v1/resolve'))).toBe(false);
		expect(mistralCalls()[0].init.body).toBe(RAW_BODY);
	});

	it('passes a Mistral 429 through with its status, body and retry-after', async () => {
		upstream = () =>
			new Response('{"message":"Requests rate limit exceeded"}', {
				status: 429,
				headers: { 'content-type': 'application/json', 'retry-after': '7' }
			});
		const res = await POST({ request: turn() });
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBe('7');
		expect(await res.text()).toBe('{"message":"Requests rate limit exceeded"}');
	});

	it("refuses (401) a bearer that is not one of the host's Mistral keys, including the gateway key, and calls nothing upstream", async () => {
		for (const bearer of ['someone-elses-mistral-key', 'sk-gateway']) {
			const res = await POST({ request: turn(bearer) });
			expect(res.status, bearer).toBe(401);
		}
		expect(calls).toHaveLength(0);
	});

	it('refuses (401) La Plateforme keys: chat only reaches this route as its router lane, which sends MISTRAL_CHAT_API_KEY', async () => {
		mockEnv.env.MISTRAL_API_KEY = 'mk-platform';
		mockEnv.env.MISTRAL_API_KEY_CI = 'mk-ci';
		for (const bearer of ['mk-platform', 'mk-ci']) {
			const res = await POST({ request: turn(bearer) });
			expect(res.status, bearer).toBe(401);
		}
		expect(calls).toHaveLength(0);
	});

	it('rejects a body with no messages (400) without calling Mistral', async () => {
		const res = await POST({ request: turn(HOST_KEY, '{"model":"mistral-large-2512"}') });
		expect(res.status).toBe(400);
		expect(mistralCalls()).toHaveLength(0);
	});

	it('GET reports the lane and upstream host behind the same gate', async () => {
		const ok = await GET({
			request: new Request('http://app/x', { headers: { authorization: `Bearer ${HOST_KEY}` } })
		});
		expect(await ok.json()).toMatchObject({
			lane: 'mistral',
			mode: 'observe',
			upstream: 'api.mistral.ai'
		});
		const anon = await GET({ request: new Request('http://app/x') });
		expect(anon.status).toBe(401);
	});
});
