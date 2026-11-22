// Playwright config for e2e/selfhost-files.spec.ts, kept apart from the scenario suite like
// owui-migrate.config.ts: the suite's testDir is ./scenarios, so no PR check, gallery run or persona run
// collects this spec. It needs the self-host compose stack running and `docker compose` on the host,
// which the source repository's self-host CI provides.
import { defineConfig } from '@playwright/test';

// SELFHOST_FILES_KIND=image runs the image test alone; anything else runs the text-file test alone.
const IMAGE_TEST = /adds an image to a chat/;
const imageKind = process.env.SELFHOST_FILES_KIND === 'image';

export default defineConfig({
	testDir: '.',
	testMatch: /selfhost-files\.spec\.ts$/,
	workers: 1,
	retries: 0,
	timeout: 300_000,
	reporter: [['list']],
	...(imageKind ? { grep: IMAGE_TEST } : { grepInvert: IMAGE_TEST }),
	outputDir: `../test-results/selfhost-files-${process.env.SELFHOST_FILES_BACKEND ?? 'unset'}${imageKind ? '-image' : ''}${process.env.SELFHOST_FILES_EXPECT_SEALED === '1' ? '-sealed' : ''}`,
	use: {
		baseURL: process.env.SELFHOST_BASE_URL ?? 'http://localhost:3000',
		trace: 'retain-on-failure',
		screenshot: 'on'
	}
});
