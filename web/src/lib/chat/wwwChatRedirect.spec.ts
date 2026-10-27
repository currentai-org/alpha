import { describe, expect, it } from 'vitest';
import { wwwChatRedirect } from '$lib/chat/wwwChatRedirect';
import { unlocalizedPath } from '$lib/i18n/routing';

const PAGE_LOAD = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' };
const FETCH = { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: 'application/json' };

function target(href: string, headers: Record<string, string>, method = 'GET') {
	const url = new URL(href);
	return wwwChatRedirect(url, method, new Headers(headers), unlocalizedPath(url.pathname));
}

// chat's pages move from www to alpha; every caller that can't follow a cross-host redirect
// keeps getting its answer on www. (CUR-4439)
describe('wwwChatRedirect', () => {
	it('sends a page load of www/chat to alpha at the same path without /chat, keeping the query', () => {
		expect(target('https://www.aipotluck.org/chat?model=x', PAGE_LOAD)).toBe(
			'https://alpha.aipotluck.org/?model=x'
		);
		expect(target('https://www.aipotluck.org/chat/conversation/abc', PAGE_LOAD)).toBe(
			'https://alpha.aipotluck.org/conversation/abc'
		);
	});

	it('keeps the locale prefix, so /fr/chat lands on /fr/chat on alpha', () => {
		expect(target('https://www.aipotluck.org/fr/chat/settings', PAGE_LOAD)).toBe(
			'https://alpha.aipotluck.org/fr/chat/settings'
		);
	});

	// The connector's state cookie is host-only on alpha, where the flow started.
	it('sends a navigation to an OAuth callback under /chat/api to alpha, where its state cookie lives', () => {
		expect(
			target('https://www.aipotluck.org/chat/api/storage/locations/hf/callback?code=c&state=s', PAGE_LOAD)
		).toBe('https://alpha.aipotluck.org/chat/api/storage/locations/hf/callback?code=c&state=s');
	});

	it('sends a crawler that asks for HTML without fetch metadata to alpha', () => {
		expect(target('https://www.aipotluck.org/chat', { accept: 'text/html,*/*' })).toBe(
			'https://alpha.aipotluck.org/'
		);
	});

	it('answers a script fetch on www, never redirecting it cross-host', () => {
		expect(target('https://www.aipotluck.org/chat/api/models', FETCH)).toBeNull();
	});

	it('answers a POST on www even when it is a navigation, since a 308 would resend the body cross-host', () => {
		expect(target('https://www.aipotluck.org/chat/conversation', PAGE_LOAD, 'POST')).toBeNull();
	});

	it('answers a Vercel cron or monitor (no fetch metadata, no HTML) on www', () => {
		expect(target('https://www.aipotluck.org/chat/api/warm', { 'user-agent': 'vercel-cron/1.0' })).toBeNull();
		expect(target('https://www.aipotluck.org/chat/healthcheck', { accept: '*/*' })).toBeNull();
	});

	it('answers /chat/.well-known on www, because an authorization server fetches it by its exact URL', () => {
		expect(target('https://www.aipotluck.org/chat/.well-known/oauth-cimd', PAGE_LOAD)).toBeNull();
	});

	it('leaves a framed /chat on www, so an embed is not pulled to another host', () => {
		expect(
			target('https://www.aipotluck.org/chat', { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' })
		).toBeNull();
	});

	it('touches no other host or path: alpha, mozfest, develop, a vercel.app URL, www pages outside /chat', () => {
		for (const href of [
			'https://alpha.aipotluck.org/chat',
			'https://mozfest.aipotluck.org/chat',
			'https://develop.aipotluck.org/chat',
			'https://aipotluck-abc.vercel.app/chat',
			'https://www.aipotluck.org/',
			'https://www.aipotluck.org/chatter',
			'https://www.aipotluck.org/map'
		]) {
			expect(target(href, PAGE_LOAD), href).toBeNull();
		}
	});
});
