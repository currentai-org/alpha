import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../guard', () => ({ requireLocationsAccess: vi.fn().mockResolvedValue('acct') }));
vi.mock('$lib/chat/server/storage/locations/registry', async (importOriginal) => ({
	...(await importOriginal<object>()),
	credentialSecret: () => 'secret'
}));

import { GET } from './+server';

/** Run the connect route for `bucket` and return where it redirected. */
async function connect(bucket: string): Promise<string> {
	const url = new URL(`https://alpha.test/chat/api/storage/locations/hf/connect?bucket=${encodeURIComponent(bucket)}`);
	try {
		// @ts-expect-error - RequestEvent is heavier than this test needs
		await GET({ locals: {}, cookies: { set: () => {} }, url });
	} catch (e) {
		const location = (e as { location?: string }).location;
		if (location) return location;
		throw e;
	}
	throw new Error('the connect route returned without redirecting');
}

describe('Hugging Face connect (CUR-4234)', () => {
	it('sends a name Hugging Face would refuse back to Storage settings with the name, instead of a bare error page', async () => {
		expect(await connect('trail-')).toBe('/chat/settings/storage?connect_error=name&bucket=trail-');
	});
});
