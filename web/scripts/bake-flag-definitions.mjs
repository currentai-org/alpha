#!/usr/bin/env node
// Every Vercel build fetches its flag definitions once and bakes them in, so a cold instance has
// flags before its first PostHog fetch returns (CUR-4199).
//
// A PR preview serves the baked set and never fetches. Scenario runs start many short-lived Lambda
// instances per preview, and each one polling on its own makes up most of the project's billed flag
// requests (Axiom `[flags]` lines).
//
// develop and production seed with the baked set and still fetch live, so a flag flipped in PostHog
// reaches them without a redeploy. Without a seed a cold instance reads code fallbacks (off) until its
// first fetch lands, and a frozen or slow fetch holds the picker at one model (CUR-4194). Seeding
// from last known values is the fallback LaunchDarkly's resilience guide recommends.
//
// Never fails the build. Every path that does not write the file deletes any stale one first, so the
// runtime finds no file and polls: that costs a cold start its flags, never correctness.
// `flagDefinitionsBaked.ts` reads the file and says in its log line which mode it got.

import { rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../src/lib/chat/server/flag-definitions.baked.json", import.meta.url));

/**
 * Whether this build bakes, and how the runtime uses what it baked: `frozen` (a PR preview, never
 * fetches) or `seed` (develop and production, fetch live on top), from Vercel's own system variables.
 */
export function bakeDecision(env) {
	const keys = !env.POSTHOG_FLAGS_SECRET_KEY
		? "POSTHOG_FLAGS_SECRET_KEY unset"
		: !env.PUBLIC_POSTHOG_KEY
			? "PUBLIC_POSTHOG_KEY unset"
			: null;
	if (env.VERCEL_ENV === "production")
		return keys ? { bake: false, why: keys } : { bake: true, mode: "seed", why: "production" };
	if (env.VERCEL_ENV !== "preview") return { bake: false, why: `VERCEL_ENV=${env.VERCEL_ENV ?? "unset"}` };
	if (!env.VERCEL_GIT_COMMIT_REF) return { bake: false, why: "VERCEL_GIT_COMMIT_REF unset" };
	if (keys) return { bake: false, why: keys };
	return env.VERCEL_GIT_COMMIT_REF === "develop"
		? { bake: true, mode: "seed", why: "develop" }
		: { bake: true, mode: "frozen", why: `PR preview (${env.VERCEL_GIT_COMMIT_REF})` };
}

/** Same rule as src/lib/chat/server/posthogHost.ts: only an absolute PUBLIC_POSTHOG_HOST is a server host. */
function host(env) {
	const h = (env.PUBLIC_POSTHOG_HOST ?? "").trim();
	return h && !h.startsWith("/") ? h : "https://us.i.posthog.com";
}

async function main() {
	await rm(OUT, { force: true });
	const d = bakeDecision(process.env);
	if (!d.bake) {
		console.log(`[bake-flag-definitions] not baking: ${d.why}`);
		return;
	}
	const t0 = Date.now();
	try {
		// The endpoint and auth posthog-node's own poller uses (FeatureFlagsPoller._requestFeatureFlagDefinitions).
		const res = await fetch(
			`${host(process.env)}/flags/definitions?token=${encodeURIComponent(process.env.PUBLIC_POSTHOG_KEY)}&send_cohorts`,
			{
				headers: { Authorization: `Bearer ${process.env.POSTHOG_FLAGS_SECRET_KEY}` },
				signal: AbortSignal.timeout(10_000),
			}
		);
		if (!res.ok) {
			console.warn(`[bake-flag-definitions] HTTP ${res.status}: not baking, the deployment will poll`);
			return;
		}
		const body = await res.json();
		if (!Array.isArray(body?.flags) || body.flags.length === 0) {
			console.warn("[bake-flag-definitions] no flags in the response: not baking, the deployment will poll");
			return;
		}
		// The shape posthog-node's FlagDefinitionCacheData expects back from a cache provider.
		const data = {
			flags: body.flags,
			groupTypeMapping: body.group_type_mapping ?? {},
			cohorts: body.cohorts ?? {},
			bakedAt: new Date().toISOString(),
			mode: d.mode,
		};
		await writeFile(OUT, JSON.stringify(data));
		console.log(
			`[bake-flag-definitions] baked ${data.flags.length} flag definitions in ${Date.now() - t0}ms (${d.mode}, ${d.why})`
		);
	} catch (e) {
		console.warn(
			`[bake-flag-definitions] ${e instanceof Error ? e.message : String(e)}: not baking, the deployment will poll`
		);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
