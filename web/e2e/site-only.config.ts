// Playwright config for e2e/site-only.spec.ts, kept apart from the scenario suite like
// selfhost-files.config.ts: the suite's testDir is ./scenarios and its global setup needs chat (a chat
// entry that answers 200, a database for sign-in codes), which a site-only build has none of. Only
// .github/workflows/site-only-smoke.yml runs it, against the site-only build it starts.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	testMatch: /site-only\.spec\.ts$/,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	reporter: [['list']],
	outputDir: '../test-results/site-only',
	use: {
		...devices['Desktop Chrome'],
		baseURL: process.env.SITE_ONLY_BASE_URL ?? 'http://localhost:4173',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	}
});
