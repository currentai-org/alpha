import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
	env: { OPENAI_API_KEY: 'sk-host' } as Record<string, string | undefined>
}));
vi.mock('$env/dynamic/private', () => mockEnv);
const mockFlag = vi.hoisted(() => ({ enabled: false }));
vi.mock('$lib/chat/server/flags', () => ({
	ensureFlagsPolled: async () => {},
	flagEnabledOr: () => mockFlag.enabled
}));

import { adapterGate } from './flag';

const req = (authorization?: string) =>
	new Request('http://adapter/v1/models', { headers: authorization ? { authorization } : {} });

// Driven through adapterGate rather than callerAuthorized directly (CUR-1626 un-exported it): the
// claim worth pinning is what the ROUTE answers a caller, not what a predicate returns. The flag is
// on throughout, so a 401 here can only be the credential check.
describe('adapterGate auth (fail closed: the host key is the adapter password)', () => {
	beforeEach(() => {
		mockEnv.env.OPENAI_API_KEY = 'sk-host';
		mockFlag.enabled = true;
	});

	it('lets the exact host bearer through', async () => {
		expect(await adapterGate(req('Bearer sk-host'))).toBeNull();
	});

	it('refuses a wrong key, a wrong scheme, and a missing header', async () => {
		for (const header of ['Bearer sk-other', 'Basic sk-host', undefined]) {
			expect(
				(await adapterGate(req(header)))?.status,
				`the adapter served a caller presenting ${header ?? 'no credential'}`
			).toBe(401);
		}
	});

	it('refuses every caller when OPENAI_API_KEY is unset or empty', async () => {
		mockEnv.env.OPENAI_API_KEY = '';
		expect((await adapterGate(req('Bearer ')))?.status).toBe(401);
		mockEnv.env.OPENAI_API_KEY = undefined;
		expect((await adapterGate(req('Bearer sk-host')))?.status).toBe(401);
	});
});

// A positive test that only asserts "a disabled adapter refuses the request" would also pass for a
// bare 404 (CUR-1626). The response has to hold a pair of distinctions, so each test below names one
// and fails if the two states it separates collapse back together.
describe('adapterGate (a disabled route and a missing route must not answer the same)', () => {
	const authed = () =>
		new Request('http://adapter/v1/models', { headers: { authorization: 'Bearer sk-host' } });
	const anonymous = () => new Request('http://adapter/v1/models');

	beforeEach(() => {
		mockEnv.env.OPENAI_API_KEY = 'sk-host';
		mockFlag.enabled = false;
	});

	it('does not answer 404 when the flag is off, because the route is there and we turned it off', async () => {
		const res = await adapterGate(authed());
		expect(res, 'a disabled adapter let an authorized request through').not.toBeNull();
		expect(
			res?.status,
			'the disabled adapter still answers 404, so our own catalog fetch cannot tell an off-switch from a wrong base URL — that is the seam that emptied a preview model registry for the life of an instance (CUR-1246)'
		).not.toBe(404);
	});

	it('names the flag in a header, so a machine can tell "off on purpose" from "unreachable"', async () => {
		const res = await adapterGate(authed());
		expect(
			res?.headers.get('x-folkways-disabled'),
			'nothing in the response says which flag is off, so every reader is back to guessing from a status code'
		).toBe('folkways-adapter');
		const body = await res?.json();
		expect(body?.error?.type).toBe('folkways_adapter_disabled');
	});

	it('answers a bad key identically whether the flag is on or off, so its state is not readable from outside', async () => {
		mockFlag.enabled = false;
		const off = await adapterGate(anonymous());
		mockFlag.enabled = true;
		const on = await adapterGate(anonymous());
		expect(
			[off?.status, on?.status],
			'an anonymous caller gets a different status depending on the flag, so the flag state leaks — this is what the original 404 was meant to prevent and never did, because the flag was checked before auth'
		).toEqual([401, 401]);
	});

	it('still separates a bad key from a disabled adapter, rather than trading one collapse for another', async () => {
		const badKey = await adapterGate(anonymous());
		const disabled = await adapterGate(authed());
		expect(
			badKey?.status === disabled?.status,
			'a wrong credential and a disabled adapter now answer the same, which is this defect pointed the other way'
		).toBe(false);
	});

	it('lets an authorized caller through when the flag is on', async () => {
		mockFlag.enabled = true;
		expect(await adapterGate(authed())).toBeNull();
	});

	it('says in words that this is configuration, not an outage', async () => {
		const body = await (await adapterGate(authed()))?.json();
		expect(body.error.message).toContain('not an outage');
		expect(body.error.flag).toBe('folkways-adapter');
	});
});
