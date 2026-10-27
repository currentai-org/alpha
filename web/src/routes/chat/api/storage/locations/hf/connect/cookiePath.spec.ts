import { describe, expect, it, vi } from 'vitest';

// The chat surface (alpha.aipotluck.org, APP_SURFACE=chat) serves chat at the root, so `base` is "".
vi.mock('$lib/chat/paths', async (importOriginal) => ({
	...(await importOriginal<object>()),
	base: ''
}));
vi.mock('../../../guard', () => ({ requireLocationsAccess: vi.fn().mockResolvedValue('acct') }));
vi.mock('$lib/chat/server/storage/locations/registry', async (importOriginal) => ({
	...(await importOriginal<object>()),
	credentialSecret: () => 'secret'
}));
vi.mock('$lib/chat/server/storage/locations/hfOAuth', async (importOriginal) => {
	const { CHAT_API_PATH } = await import('$lib/chat/paths');
	return {
		...(await importOriginal<object>()),
		storageOAuthApp: () => ({
			clientId: 'c',
			clientSecret: 's',
			redirectUri: `https://alpha.test${CHAT_API_PATH}/storage/locations/hf/callback`
		})
	};
});

import { GET } from './+server';

describe('Hugging Face connect cookie on the chat surface', () => {
	it('sets the connect cookie on a path the callback Hugging Face returns to lies under, so the state check can read it', async () => {
		let cookiePath: string | undefined;
		const cookies = { set: (_n: string, _v: string, opts: { path: string }) => (cookiePath = opts.path) };
		const url = new URL('https://alpha.test/api/storage/locations/hf/connect');
		let location = '';
		try {
			// @ts-expect-error - RequestEvent is heavier than this test needs
			await GET({ locals: {}, cookies, url });
		} catch (e) {
			location = (e as { location?: string }).location ?? '';
		}
		const callbackPath = new URL(new URL(location).searchParams.get('redirect_uri')!).pathname;
		expect(cookiePath).toBeDefined();
		expect(
			callbackPath.startsWith(`${cookiePath}/`),
			`cookie path ${cookiePath} does not cover the callback ${callbackPath}`
		).toBe(true);
	});
});
