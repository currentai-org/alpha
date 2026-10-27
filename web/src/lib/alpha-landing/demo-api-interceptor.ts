import { base } from '$lib/chat/paths';
import { setDemoApiFetchInterceptor } from '$lib/chat/demoApiFetch';
import type { WipeSummary } from '$lib/chat/types/WipeSummary';
import superjson from 'superjson';

const DEMO_WIPE_SUMMARY: WipeSummary = {
	conversations: 3,
	settings: 1,
	messageEvents: 0,
	contributions: 0,
	localInferenceEndpoints: 0,
	storageLocations: 0,
	reportsRetained: 0,
	safetyEvents: 0,
	accountDeleted: false
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(superjson.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function emptyOk(): Response {
	return new Response('', { status: 200 });
}

/** Wire demo-only API responses for the Alpha marketing embed. */
export function registerAlphaDemoApiInterceptor(): void {
	const apiPrefix = `${base}/api/v2`;

	setDemoApiFetchInterceptor((url, init) => {
		const { pathname } = new URL(url, 'http://localhost');
		const method = (init.method ?? 'GET').toUpperCase();

		if (pathname === `${base}/api/report` && method === 'POST') {
			return emptyOk();
		}

		if (!pathname.startsWith(apiPrefix)) return null;
		const rest = pathname.slice(apiPrefix.length);

		if (method === 'DELETE' && rest === '/conversations') {
			return jsonResponse(DEMO_WIPE_SUMMARY);
		}

		if (method === 'GET' && rest === '/conversations') {
			return jsonResponse({ conversations: [], hasMore: false });
		}

		if (method === 'DELETE' && /^\/conversations\/[^/]+$/.test(rest)) {
			return jsonResponse({ deleted: true });
		}

		if (rest.startsWith('/user/') || rest.startsWith('/export')) {
			if (method === 'GET') {
				return jsonResponse({});
			}
			return emptyOk();
		}

		if (rest.startsWith('/conversations')) {
			if (method === 'GET') {
				return jsonResponse({ messages: [] });
			}
			if (method === 'POST' || method === 'PATCH') {
				return jsonResponse({});
			}
			if (method === 'DELETE') {
				return jsonResponse({ deleted: true });
			}
		}

		return null;
	});
}

export function unregisterAlphaDemoApiInterceptor(): void {
	setDemoApiFetchInterceptor(null);
}
