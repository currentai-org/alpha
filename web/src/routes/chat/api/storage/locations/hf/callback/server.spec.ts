import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	listStorageLocations: vi.fn(),
	createStorageLocation: vi.fn(),
	setStorageLocationCredential: vi.fn(),
	setStorageLocationStatus: vi.fn()
}));
const { provisionAlphaBucket } = vi.hoisted(() => ({ provisionAlphaBucket: vi.fn() }));

vi.mock('$lib/chat/server/db/storageLocations', () => db);
vi.mock('../../../guard', () => ({ requireLocationsAccess: vi.fn().mockResolvedValue('acct') }));
vi.mock('$lib/chat/server/storage/locations/connectState', () => ({
	CONNECT_COOKIE: 'hf_connect',
	CONNECT_COOKIE_PATH: '/chat/api/storage/locations/hf',
	checkConnectState: () => ({ ok: true, verifier: 'v', bucket: undefined })
}));
vi.mock('$lib/chat/server/storage/locations/hfOAuth', async (importOriginal) => ({
	...(await importOriginal<object>()),
	storageOAuthApp: () => ({ clientId: 'c' }),
	exchangeCode: vi.fn().mockResolvedValue({ access_token: 'invented' }),
	grantUsername: vi.fn().mockResolvedValue('someone'),
	serializeGrant: () => 'grant',
	provisionAlphaBucket
}));
vi.mock('$lib/chat/server/storage/locations/sealedSecret', () => ({ seal: () => 'sealed' }));
vi.mock('$lib/chat/server/storage/locations/registry', async (importOriginal) => ({
	...(await importOriginal<object>()),
	credentialSecret: () => 'secret'
}));

import { GET } from './+server';
import { BucketTakenError } from '$lib/chat/server/storage/locations/hfOAuth';

/** Run the callback and return where it redirected. */
async function callback(): Promise<string> {
	const url = new URL('https://alpha.test/chat/api/storage/locations/hf/callback?code=c&state=s');
	const cookies = { get: () => 'sealed', delete: () => {} };
	try {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await GET({ locals: {}, cookies, url });
	} catch (e) {
		const location = (e as { location?: string }).location;
		if (location) return location;
		throw e;
	}
	throw new Error('the callback returned without redirecting');
}

beforeEach(() => {
	vi.clearAllMocks();
	provisionAlphaBucket.mockResolvedValue('someone/alpha-files');
	db.listStorageLocations.mockResolvedValue([]);
});

describe('Hugging Face connect callback (CUR-3326)', () => {
	it('says the bucket was already linked when Connect lands on a bucket this account has, rather than reporting a new link', async () => {
		db.listStorageLocations.mockResolvedValue([
			{ id: 'loc-1', config: { repo: 'someone/alpha-files', grant: 'oauth' } }
		]);
		const to = await callback();
		expect(to).toMatch(/\?connected=refreshed&bucket=someone%2Falpha-files$/);
		expect(db.setStorageLocationCredential).toHaveBeenCalledWith('acct', 'loc-1', 'sealed');
		expect(db.createStorageLocation).not.toHaveBeenCalled();
	});

	it('refreshes the linked bucket when Connect names it in another case, since Hugging Face names ignore case (CUR-4234)', async () => {
		provisionAlphaBucket.mockResolvedValue('someone/ALPHA-FILES');
		db.listStorageLocations.mockResolvedValue([
			{ id: 'loc-1', config: { repo: 'someone/alpha-files', grant: 'oauth' } }
		]);
		const to = await callback();
		expect(to).toMatch(/\?connected=refreshed&bucket=someone%2Falpha-files$/);
		expect(db.createStorageLocation).not.toHaveBeenCalled();
	});

	it('says the name is taken and hands it back when the bucket exists and Alpha did not make it (CUR-4234)', async () => {
		provisionAlphaBucket.mockRejectedValue(new BucketTakenError('taken'));
		const to = await callback();
		expect(to).toMatch(/\?connect_error=taken&bucket=alpha-files$/);
		expect(db.createStorageLocation).not.toHaveBeenCalled();
	});

	it('reports a new link as connected, naming the new location so the page can offer to move files there (CUR-2941)', async () => {
		db.createStorageLocation.mockResolvedValue({ id: 'loc-new' });
		const to = await callback();
		expect(to).toMatch(/\?connected=1&location=loc-new$/);
		expect(db.createStorageLocation).toHaveBeenCalledOnce();
	});
});
