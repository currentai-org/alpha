// CUR-1512 — visual regression, a SEPARATE suite and config from e2e/scenarios/. Deliberately: the
// scenario suite's global-setup.ts requires SCENARIO_DATABASE_URL and drives real sign-in/workspace
// flows against a live Postgres. Visual snapshots need none of that — just a rendered page — and
// bundling them into the same config would make every visual-only run pay the DB-provisioning cost
// scenario-suite-check.yml's run-scenarios job carries for its OWN, unrelated reasons.
//
// Comparison only ever runs in CI. Font rendering (subpixel hinting, ligatures, fallback substitution)
// differs across host OS/font packages, so two renders from different hosts produce diffs that are
// real pixels but not real regressions. Playwright's own docs name the fix: render both sides inside
// the SAME pinned Docker image. scenario-suite-check.yml's visual-regression job does that in one job
// (SOL-231): it renders develop's build of the PR's merge-base with
// `--update-snapshots=all`, then compares the PR's preview against what it just wrote. No baseline is
// committed, so `__screenshots__` is gitignored, and a local run is only a diff worth looking at.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	testMatch: '**/*.visual.spec.ts',
	// Written by the job's baseline render and read by its comparison, in the same run.
	snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
	workers: 1,
	retries: 0,
	timeout: 30_000,
	expect: {
		// Playwright's stock default (0.2) already tolerates ordinary anti-aliasing noise between two
		// renders of the identical page in the identical container — this is the thing "goes red on a
		// one-pixel deliberate change" needs to survive without also being loose enough to miss one.
		toHaveScreenshot: { maxDiffPixels: 10 }
	},
	reporter: process.env.CI ? [['github'], ['list']] : [['list']],
	use: {
		baseURL: process.env.VISUAL_BASE_URL,
		screenshot: 'off',
		video: 'off',
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
