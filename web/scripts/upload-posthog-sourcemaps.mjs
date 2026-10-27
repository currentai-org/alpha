#!/usr/bin/env node
// Tag the built client chunks with a PostHog chunk id and upload their source maps, so a
// captured exception's stack reads as real source (`Toast.svelte:14`) instead of `chunk-A1B2.js:1:48210`.
//
//   node scripts/upload-posthog-sourcemaps.mjs
//
// OPERATES ON .vercel/output/static. adapter-vercel copies the client build there as part of the SAME
// `vite build` invocation that runs this script after — that copy, and not the intermediate
// .svelte-kit/output/client, is what Vercel actually serves. Tagging or deleting maps in the wrong
// directory would ship raw source maps regardless of what happened here.
//
// `inject` is not a credential-free local step: it fails with the same "couldn't find
// POSTHOG_CLI_API_KEY" error as `upload`. So the credential check
// below gates the whole step, not just the network half: `POSTHOG_CLI_API_KEY` (a personal API key
// scoped to error_tracking:write; the project's public PUBLIC_POSTHOG_KEY can't authenticate CLI
// calls) plus `POSTHOG_CLI_PROJECT_ID`.
//
// MAPS ARE DELETED EITHER WAY. Vite writes .map files into this directory regardless of whether
// posthog-cli ever runs, so a missing credential can't just mean "skip quietly" — the maps would sit
// in the served output, publicly fetchable by anyone who appends .map to a chunk URL (`hidden` mode
// only removes the `//# sourceMappingURL` comment that would point a browser at them automatically;
// it doesn't block a direct request). Uploaded-then-deleted and skipped-then-deleted both leave zero
// maps in what ships — the only difference is whether PostHog has a copy to symbolicate against.
// Missing credentials degrade loudly (same posture as errorTracking.ts when PUBLIC_POSTHOG_KEY is
// unset) and never fail the deploy, but they do cost readable stacks for that build. A CLI failure
// WITH credentials present — a network error, a rotated/revoked key, an upstream error — degrades the
// same way rather than throwing: analytics availability must not be able to gate every deploy, the same argument errorTracking.ts makes for never letting reporting replace
// a real error. Caught here explicitly, not left to escape and abort the `&&`-chained vercel-build. (CUR-1510)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const DIR = ".vercel/output/static";
const CLI = "posthog-cli";

function releaseVersion() {
	if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.trim();
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

function run(args) {
	execFileSync(CLI, args, { stdio: "inherit" });
}

function deleteMaps(dir) {
	let count = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".map")) continue;
		rmSync(join(entry.parentPath, entry.name));
		count++;
	}
	return count;
}

function main() {
	if (!existsSync(DIR)) {
		console.log(`[posthog-sourcemaps] ${DIR} doesn't exist — not a Vercel build, skipping`);
		return;
	}

	const apiKey = process.env.POSTHOG_CLI_API_KEY || process.env.POSTHOG_CLI_TOKEN;
	const projectId = process.env.POSTHOG_CLI_PROJECT_ID || process.env.POSTHOG_CLI_ENV_ID;
	if (!apiKey || !projectId) {
		const removed = deleteMaps(DIR);
		console.log(
			`[posthog-sourcemaps] POSTHOG_CLI_API_KEY/POSTHOG_CLI_PROJECT_ID unset — removed ${removed} ` +
				"unlinked .map file(s) rather than ship them unindexed. Captured exceptions will show " +
				"minified stacks until this is set."
		);
		return;
	}

	const release = releaseVersion();
	const releaseArgs = release ? ["--release-version", release] : [];
	try {
		run(["sourcemap", "inject", "--directory", DIR, ...releaseArgs]);
		run(["sourcemap", "upload", "--directory", DIR, "--delete-after", ...releaseArgs]);
		console.log("[posthog-sourcemaps] uploaded and stripped from the served output");
	} catch (e) {
		const removed = deleteMaps(DIR);
		console.log(
			`[posthog-sourcemaps] sourcemap inject/upload failed (${e.message}) — removed ${removed} ` +
				"unlinked .map file(s) rather than ship them unindexed. Captured exceptions will show " +
				"minified stacks for this build."
		);
	}
}

main();
