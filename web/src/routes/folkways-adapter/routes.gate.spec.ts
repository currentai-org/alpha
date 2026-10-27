import { beforeEach, describe, expect, it, vi } from 'vitest';

// CUR-1626, at the level the defect lived: what each of the four real handlers answers. flag.spec.ts
// pins adapterGate itself, which stays green if a handler stops calling it or calls it after its own
// work. These tests import the four exported handlers and fail in either case (dropping the gate
// from the safety handler turns its two cases red while flag.spec.ts stays 9/9). A new handler needs
// adding to the list below. With the gate refusing, nothing past it runs, so the handlers' other
// dependencies are stubbed only so their modules can load.

const mockEnv = vi.hoisted(() => ({
	// The Mistral route's caller key is the host's Mistral key; the same value keeps one `authed`.
	env: { OPENAI_API_KEY: 'sk-host', MISTRAL_CHAT_API_KEY: 'sk-host' } as Record<
		string,
		string | undefined
	>
}));
vi.mock('$env/dynamic/private', () => mockEnv);
vi.mock('$env/static/public', () => ({ PUBLIC_COMMIT_SHA: 'test' }));
const mockFlag = vi.hoisted(() => ({ enabled: false }));
vi.mock('$lib/chat/server/flags', () => ({
	ensureFlagsPolled: async () => {},
	flagEnabledOr: () => mockFlag.enabled
}));
vi.mock('$lib/chat/server/tuning', () => ({ getTuning: async () => ({}) }));
vi.mock('$lib/chat/server/models', () => ({ defaultModel: { id: 'test-model' } }));
vi.mock('$lib/chat/server/vercelBackground', () => ({ runInBackground: () => {} }));

import { GET as modelsGET } from './v1/models/+server';
import { GET as modelInfoGET } from './v1/model/info/+server';
import { GET as safetyGET } from './v1/safety/+server';
import { GET as completionsGET, POST as completionsPOST } from './v1/chat/completions/+server';
import {
	GET as mistralCompletionsGET,
	POST as mistralCompletionsPOST
} from './mistral/v1/chat/completions/+server';

const url = 'http://adapter/v1/x';
const handlers = [
	['GET /v1/models', () => modelsGET],
	['GET /v1/model/info', () => modelInfoGET],
	['GET /v1/safety', () => safetyGET],
	['GET /v1/chat/completions', () => completionsGET],
	['POST /v1/chat/completions', () => completionsPOST],
	['GET /mistral/v1/chat/completions', () => mistralCompletionsGET],
	['POST /mistral/v1/chat/completions', () => mistralCompletionsPOST]
] as const;

const authed = (method: string) =>
	new Request(url, {
		method,
		headers: { authorization: 'Bearer sk-host', 'content-type': 'application/json' },
		body: method === 'POST' ? JSON.stringify({ model: 'test-model', messages: [] }) : undefined
	});
const anonymous = (method: string) =>
	new Request(url, {
		method,
		headers: { 'content-type': 'application/json' },
		body: method === 'POST' ? '{}' : undefined
	});

describe('every folkways-adapter handler answers the gate, not a 404, when the flag is off', () => {
	beforeEach(() => {
		mockEnv.env.OPENAI_API_KEY = 'sk-host';
		mockEnv.env.MISTRAL_CHAT_API_KEY = 'sk-host';
		mockFlag.enabled = false;
	});

	for (const [name, handler] of handlers) {
		const method = name.split(' ')[0];

		it(`${name}: an authorized caller is told the adapter is disabled (503 + x-folkways-disabled)`, async () => {
			const res = await handler()({ request: authed(method) });
			expect(
				res.status,
				`${name} did not answer the disabled response, so it skips or reorders adapterGate`
			).toBe(503);
			expect(res.headers.get('x-folkways-disabled')).toBe('folkways-adapter');
		});

		it(`${name}: a caller without the host key gets 401 whether the flag is on or off`, async () => {
			const off = (await handler()({ request: anonymous(method) })).status;
			mockFlag.enabled = true;
			const on = (await handler()({ request: anonymous(method) })).status;
			expect(
				[off, on],
				`${name} answers an anonymous caller differently depending on the flag, so the flag state leaks`
			).toEqual([401, 401]);
		});
	}
});
