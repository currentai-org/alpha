import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	testMatch: /selfhost-flags\.spec\.ts$/,
	workers: 1,
	retries: 0,
	timeout: 300_000,
	reporter: [['list']],
	outputDir: '../test-results/selfhost-flags',
	use: {
		baseURL: process.env.SELFHOST_BASE_URL ?? 'http://localhost:3000',
		trace: 'retain-on-failure'
	}
});
