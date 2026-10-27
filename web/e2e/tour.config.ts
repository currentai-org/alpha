import { defineConfig } from '@playwright/test';
import { recastVideo } from 'playwright-recast/config';

// The walkthrough tours (CUR-2789): one continuous take per project, filmed for people rather than
// asserted for CI. Kept out of playwright.config.ts's testDir so no suite ever runs them, and run
// only by .github/workflows/walkthrough.yml, which hands the trace and video to tools/tour-render.
//
// Recorded at twice the viewport so the renderer's zoom stays sharp, and traced on every run: the
// trace's click coordinates are what the rendered cursor travels between.
export default defineConfig({
	testDir: './tour',
	testMatch: /\.tour\.ts$/,
	outputDir: './tour-results',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 360_000,
	// The trace is uploaded whole, and it records the sign-in header's secret value (CUR-2918).
	reporter: [['list'], ['./reporters/redactTraceSecrets.ts']],
	use: {
		...recastVideo({ viewport: { width: 1280, height: 720 }, scale: 2 }),
		baseURL: process.env.SCENARIO_BASE_URL ?? 'https://develop.aipotluck.org',
		trace: 'on',
		locale: 'en-GB'
	}
});
