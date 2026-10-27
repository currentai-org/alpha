// Loaded into the app's own process by scripts/sign-in-local.sh (`node --import`), never imported by
// anything under src/ (CUR-1552). Better Auth compiles Google's and GitHub's token, profile and key
// URLs in, so on the local sign-in leg this wraps `fetch` and sends exactly those URLs to the mock
// provider running beside the app. Every other request goes out untouched, and the provider code that
// runs is the code that ships.
//
// It refuses to load unless MOCK_OIDC_PROVIDER_URL names a loopback host, the same rule the app's own
// mock registration follows (mockOidc.ts), so it can't send sign-in traffic anywhere public.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const mock = (process.env.MOCK_OIDC_PROVIDER_URL ?? '').replace(/\/+$/, '');
let mockHost = '';
try {
	mockHost = new URL(mock).hostname;
} catch {
	// handled below
}
if (!LOOPBACK_HOSTS.has(mockHost)) {
	throw new Error(
		`provider-redirect: MOCK_OIDC_PROVIDER_URL must name a loopback host, got ${JSON.stringify(mock)}`
	);
}

const ROUTES = new Map([
	['https://github.com/login/oauth/access_token', `${mock}/token?provider=github`],
	['https://api.github.com/user', `${mock}/github/user`],
	['https://api.github.com/user/emails', `${mock}/github/user/emails`],
	['https://oauth2.googleapis.com/token', `${mock}/token?provider=google`],
	['https://www.googleapis.com/oauth2/v3/certs', `${mock}/jwks`]
]);

const realFetch = globalThis.fetch;
globalThis.fetch = function fetchThroughMock(input, init) {
	const url = input instanceof Request ? input.url : String(input);
	const target = ROUTES.get(url);
	if (!target) return realFetch(input, init);
	return realFetch(input instanceof Request ? new Request(target, input) : target, init);
};
