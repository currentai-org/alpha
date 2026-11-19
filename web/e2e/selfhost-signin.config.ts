// Playwright config for e2e/selfhost-signin.spec.ts, kept apart from the scenario suite like
// owui-migrate.config.ts: the suite's testDir is ./scenarios, so no PR check, gallery run or persona run
// collects this spec. It needs the self-host compose stack running, which only
// .github/workflows/selfhost-smoke.yml provides; SELFHOST_SIGNIN_MODE picks which sign-in it walks.
import { defineConfig } from '@playwright/test';

const mode = process.env.SELFHOST_SIGNIN_MODE ?? 'password';

export default defineConfig({
	testDir: '.',
	testMatch: /selfhost-signin\.spec\.ts$/,
	workers: 1,
	retries: 0,
	timeout: 180_000,
	reporter: [['list']],
	outputDir: `../test-results/selfhost-signin-${mode}`,
	use: {
		baseURL: process.env.SELFHOST_BASE_URL ?? 'http://localhost:3000',
		viewport: { width: 1280, height: 900 },
		trace: 'retain-on-failure',
		screenshot: 'on'
	}
});
