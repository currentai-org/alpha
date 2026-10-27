import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listStorageLocations, createStorageLocation } = vi.hoisted(() => ({
	listStorageLocations: vi.fn(),
	createStorageLocation: vi.fn()
}));
const { verifyBucketLink } = vi.hoisted(() => ({ verifyBucketLink: vi.fn() }));

vi.mock('$lib/chat/server/db/storageLocations', () => ({ listStorageLocations, createStorageLocation }));
vi.mock('$lib/chat/server/storage/custodialStorageGate', () => ({
	CUSTODIAL_STORAGE_VIEW_FLAG: 'custodial-storage-view',
	custodialStorageViewEnabledForUser: vi.fn().mockResolvedValue(true)
}));
vi.mock('$lib/chat/server/storage/locations/gate', () => ({
	storageLocationsEnabledForUser: vi.fn().mockResolvedValue(true)
}));
// The real name and folder parsers stay in, so "already linked" is judged on normalised values.
vi.mock('$lib/chat/server/storage/locations/hfBucketLocation', async (importOriginal) => ({
	...(await importOriginal<object>()),
	verifyBucketLink
}));
vi.mock('$lib/chat/server/storage/locations/sealedSecret', () => ({ seal: () => 'sealed' }));
vi.mock('$lib/chat/server/storage/locations/registry', async (importOriginal) => ({
	...(await importOriginal<object>()),
	credentialSecret: () => 'secret'
}));

import { POST } from './+server';

// 24 hex, the shape locals.user._id carries. Invented.
const ACCOUNT_ID = 'cccccccccccccccccccccccc';
const locals = { user: { _id: { toString: () => ACCOUNT_ID } } };

function link(body: Record<string, string>) {
	const request = new Request('https://alpha.test/chat/api/storage/locations', {
		method: 'POST',
		body: JSON.stringify({ token: 'hf_invented_token', ...body })
	});
	// @ts-expect-error - RequestEvent is heavier than this test needs
	return POST({ locals, request });
}

function row(repo: string, prefix: string) {
	return { id: `loc-${repo}-${prefix}`, config: { repo, prefix } };
}

beforeEach(() => {
	vi.clearAllMocks();
	listStorageLocations.mockResolvedValue([]);
	createStorageLocation.mockResolvedValue({ id: 'new-location' });
	verifyBucketLink.mockResolvedValue(undefined);
});

describe('linking a bucket', () => {
	it('refuses with 409 a bucket folder this account already linked, written another way, before asking the Hub', async () => {
		listStorageLocations.mockResolvedValue([row('buckets/someone/files', 'notes/')]);
		await expect(link({ bucket: 'https://huggingface.co/buckets/someone/files/', folder: '/notes' })).rejects.toMatchObject({
			status: 409
		});
		expect(verifyBucketLink).not.toHaveBeenCalled();
		expect(createStorageLocation).not.toHaveBeenCalled();
	});

	it('links a different folder of a bucket that is already linked', async () => {
		listStorageLocations.mockResolvedValue([row('buckets/someone/files', '')]);
		const res = await link({ bucket: 'someone/files', folder: 'notes' });
		expect(res.status).toBe(201);
		expect(createStorageLocation).toHaveBeenCalledWith(
			expect.objectContaining({ config: { repo: 'buckets/someone/files', prefix: 'notes/' } })
		);
	});

	it('refuses an eleventh location with 400 and stores nothing', async () => {
		listStorageLocations.mockResolvedValue(Array.from({ length: 10 }, (_, i) => row(`buckets/someone/b${i}`, '')));
		await expect(link({ bucket: 'someone/another' })).rejects.toMatchObject({ status: 400 });
		expect(createStorageLocation).not.toHaveBeenCalled();
	});
});
