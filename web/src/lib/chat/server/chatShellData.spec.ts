import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestLocals } from '$lib/chat/server/api/__tests__/testHelpers';
import { ensureChatLocalsResolved } from './chatShellData';

// hooks.server.ts's handle() only routes a /chat/* subpath through chat's own request
// pipeline ($lib/chat/server/hooks/handle.ts), which is what normally resolves
// locals.user/isAdmin/sessionId via authenticateRequest. A Payload `chat` page reached via
// [...slug] (e.g. /alpha/chat) never goes through that pipeline, so ensureChatLocalsResolved is
// the only thing standing between that request and completely unresolved locals. Mocking
// authenticateRequest in isolation (rather than pulling in the real DB, like layoutData.spec.ts
// does) keeps this in the hermetic server-fast project — the contract under test is "did we call
// the same resolver the hook calls, with the same inputs, only when the hook hasn't already run".
// vi.mock calls are hoisted above every import in this file (including the static one above), so
// the mock is in place before chatShellData.ts's own `import { authenticateRequest } from
// '$lib/chat/server/auth'` resolves. vi.hoisted, not a bare const, because the factory below is
// hoisted along with vi.mock — a plain top-level const would still be in its temporal dead zone. (CUR-1075)
const { authenticateRequest } = vi.hoisted(() => ({ authenticateRequest: vi.fn() }));
vi.mock('$lib/chat/server/auth', () => ({ authenticateRequest }));

function fakeCookies() {
	return { get: vi.fn(), set: vi.fn(), delete: vi.fn(), serialize: vi.fn() } as never;
}

describe('ensureChatLocalsResolved', () => {
	beforeEach(() => {
		authenticateRequest.mockReset();
	});

	it('resolves locals from the request when the hook never ran (no sessionId yet)', async () => {
		authenticateRequest.mockResolvedValue({
			user: { name: 'Ada' },
			sessionId: 'resolved-session',
			secretSessionId: 'resolved-secret',
			token: undefined,
			isAdmin: true
		});
		const locals = createTestLocals({ sessionId: undefined, user: undefined, isAdmin: false });
		const cookies = fakeCookies();
		const request = new Request('https://www.aipotluck.org/alpha/chat');

		await ensureChatLocalsResolved(locals, cookies, request);

		// Same three inputs handle.ts's own call passes: headers, cookies, url, isApi=false — a page
		// load is never an API path, so this must never flip that.
		expect(authenticateRequest).toHaveBeenCalledWith(
			request.headers,
			cookies,
			new URL('https://www.aipotluck.org/alpha/chat'),
			false
		);
		expect(locals.user).toEqual({ name: 'Ada' });
		expect(locals.sessionId).toBe('resolved-session');
		expect(locals.isAdmin).toBe(true);
	});

	it('is a no-op once locals.sessionId is already set (the hook already ran, e.g. /chat/*)', async () => {
		const locals = createTestLocals({ sessionId: 'already-resolved', user: undefined });
		const cookies = fakeCookies();
		const request = new Request('https://www.aipotluck.org/chat/');

		await ensureChatLocalsResolved(locals, cookies, request);

		expect(authenticateRequest).not.toHaveBeenCalled();
		expect(locals.sessionId).toBe('already-resolved');
	});

	it('is a no-op with no request (backward-compatible default for existing callers)', async () => {
		const locals = createTestLocals({ sessionId: undefined, user: undefined });
		const cookies = fakeCookies();

		await ensureChatLocalsResolved(locals, cookies, undefined);

		expect(authenticateRequest).not.toHaveBeenCalled();
		expect(locals.sessionId).toBeUndefined();
	});
});
