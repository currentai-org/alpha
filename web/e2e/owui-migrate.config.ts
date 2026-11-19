// Playwright config for e2e/owui-migrate.spec.ts, kept apart from the scenario suite like the
// cold walk's: the suite's testDir is ./scenarios, so no PR check, gallery run or persona run collects
// this spec. It needs the self-host compose stack running and `docker compose` on the host, which only
// .github/workflows/selfhost-smoke.yml provides.
import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	testMatch: /owui-migrate\.spec\.ts$/,
	workers: 1,
	retries: 0,
	// The importer boots vite-node inside the web container, and a model-free page load is quick, so
	// the budget is for the import steps.
	timeout: 300_000,
	reporter: [['list']],
	outputDir: '../test-results/owui-migrate',
	use: {
		baseURL: process.env.OWUI_BASE_URL ?? 'http://localhost:3000',
		trace: 'retain-on-failure',
		screenshot: 'on'
	}
});
