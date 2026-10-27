import { beforeEach, describe, expect, it, vi } from 'vitest';

// The callback with its real state check, and Hugging Face's token exchange stubbed, so a
// forged state is shown refused before any code is traded, and the minted one shown to reach the trade. (CUR-2932)
const SECRET = 'callback-state-test-secret';

const db = vi.hoisted(() => ({
	listStorageLocations: vi.fn(),
	createStorageLocation: vi.fn(),
	setStorageLocationCredential: vi.fn(),
	setStorageLocationStatus: vi.fn()
}));
const hub = vi.hoisted(() => ({
	exchangeCode: vi.fn(),
	grantUsername: vi.fn(),
	provisionAlphaBucket: vi.fn()
}));

vi.mock('$lib/chat/server/db/storageLocations', () => db);
vi.mock('../../../guard', () => ({ requireLocationsAccess: vi.fn().mockResolvedValue('acct-1') }));
vi.mock('$lib/chat/server/storage/locations/hfOAuth', async (importOriginal) => ({
	...(await importOriginal<object>()),
	storageOAuthApp: () => ({ clientId: 'c', clientSecret: 's', redirectUri: 'https://alpha.test/cb' }),
	serializeGrant: () => 'grant',
	...hub
}));
vi.mock('$lib/chat/server/storage/locations/registry', async (importOriginal) => ({
	...(await importOriginal<object>()),
	credentialSecret: () => SECRET
}));

import { GET } from './+server';
import { sealConnectState } from '$lib/chat/server/storage/locations/connectState';

/** Run the callback with the connect cookie the connect route would have set, and return where it went. */
async function callback(returnedState: string): Promise<string> {
	const cookie = sealConnectState({ state: 'minted-state', verifier: 'verifier', accountId: 'acct-1' }, SECRET);
	const url = new URL(
		`https://alpha.test/chat/api/storage/locations/hf/callback?code=made-up&state=${returnedState}`
	);
	try {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await GET({ locals: {}, cookies: { get: () => cookie, delete: () => {} }, url });
	} catch (e) {
		const location = (e as { location?: string }).location;
		if (location) return location;
		throw e;
	}
	throw new Error('the callback returned without redirecting');
}

beforeEach(() => {
	vi.clearAllMocks();
	hub.exchangeCode.mockResolvedValue({ access: 'hf_stub', refresh: null, expiresAt: Date.now() + 3600_000 });
	hub.grantUsername.mockResolvedValue('someone');
	hub.provisionAlphaBucket.mockResolvedValue('buckets/someone/alpha-files');
	db.listStorageLocations.mockResolvedValue([]);
	db.createStorageLocation.mockResolvedValue({ id: 'loc-new' });
});

describe('Hugging Face connect callback state check (CUR-2932)', () => {
	it('refuses a forged state before trading the code, and links nothing', async () => {
		expect(await callback('forged-state')).toMatch(/\?connect_error=state$/);
		expect(hub.exchangeCode).not.toHaveBeenCalled();
		expect(db.createStorageLocation).not.toHaveBeenCalled();
	});

	it('trades the code with the minted verifier when the state matches, and links the bucket', async () => {
		expect(await callback('minted-state')).toMatch(/\?connected=1&location=loc-new$/);
		expect(hub.exchangeCode).toHaveBeenCalledWith(expect.anything(), 'made-up', 'verifier');
		expect(db.createStorageLocation).toHaveBeenCalledOnce();
	});
});
