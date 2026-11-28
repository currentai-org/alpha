import { writeFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { SHIELDSTRAL_PAIRED_RULES } from "../../../../../config/safetyScreen";
import { CATEGORY_FIXTURES, BENIGN_FIXTURES } from "../../../../../scripts/lib/shieldFixtures.mjs";
import { loadGuardPolicy, thresholdFor } from "$lib/chat/server/guardPolicy";
import type { JudgeCtx, JudgeTarget } from "$lib/chat/server/guardScreenTypes";
import { screenJudge } from "./safetyScreen";

// LIVE: per-rule recall and false-positive rate of the paired safety screen, beside Shieldstral alone,
// on the shared calibration fixtures (web/scripts/lib/shieldFixtures.mjs).
//
// Both arms run the real screenJudge, the gate's default judge, with SAFETY_SCREEN set per arm: the
// pairing sends the four SHIELDSTRAL_PAIRED_RULES to Shieldstral and the other rules to Qwen3Guard, with
// one Qwen call per fixture. It needs both llama.cpp endpoints and runs only when asked:
//   CALIBRATE_SAFETY_SCREEN=1 GUARD_SHADOW_URL=... QWEN3GUARD_URL=... pnpm test:live <this file>
// CALIBRATION_OUT names a file the markdown table is also written to. The numbers are reported, never
// asserted: trust and safety read the table and decide.

const env = (k: string) => (process.env[k] ?? "").trim();
const LIVE = env("CALIBRATE_SAFETY_SCREEN") === "1" && !!env("GUARD_SHADOW_URL") && !!env("QWEN3GUARD_URL");
const POOL = Math.max(1, Number(env("CALIBRATION_CONCURRENCY")) || 4);
const PAIRED = new Set<string>(SHIELDSTRAL_PAIRED_RULES);

type Tally = { yes: number; no: number; unknown: number };
const blank = (): Tally => ({ yes: 0, no: 0, unknown: 0 });
const noop = () => {};

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (i < items.length) await fn(items[i++]);
		})
	);
}

describe.skipIf(!LIVE)("paired safety screen calibration (live)", () => {
	it(
		"reports recall and false-positive rate per rule for the pairing and for Shieldstral alone",
		async () => {
			const policy = loadGuardPolicy();
			if (!policy) throw new Error("rules.json failed to load");
			const ctx: JudgeCtx = {
				instruct: policy.shield.instruct,
				opSignal: new AbortController().signal,
				timeoutMs: 60000,
				log: { info: noop, warn: noop, error: noop },
			};
			const fixtures = [
				...Object.entries(CATEGORY_FIXTURES as Record<string, string[]>).flatMap(([owner, texts]) =>
					texts.map((text) => ({ owner, text }))
				),
				...(BENIGN_FIXTURES as string[]).map((text) => ({ owner: "benign", text })),
			];
			const arms = ["shieldstral", "qwen3guard"] as const;
			// arm -> rule key -> {own, benign}
			const tallies = new Map<string, Map<string, { own: Tally; benign: Tally }>>();
			for (const arm of arms) {
				process.env.SAFETY_SCREEN = arm;
				const byRule = new Map(policy.entries.map((r) => [r.key, { own: blank(), benign: blank() }]));
				tallies.set(arm, byRule);
				// One target object per fixture, so the pairing's Qwen call is made once and shared by its rules.
				const jobs = fixtures.flatMap((fx) => {
					const target: JudgeTarget = { kind: "text", text: fx.text };
					return policy.entries
						.filter((r) => fx.owner === r.key || fx.owner === "benign")
						.map((rule) => ({ fx, rule, target }));
				});
				await pool(jobs, POOL, async ({ fx, rule, target }) => {
					const o = await screenJudge(target, rule.query, thresholdFor(policy, rule), ctx);
					const t = byRule.get(rule.key)![fx.owner === "benign" ? "benign" : "own"];
					if (o.answer.kind === "unknown") t.unknown++;
					else if (o.answer.yes) t.yes++;
					else t.no++;
				});
			}
			delete process.env.SAFETY_SCREEN;

			const pct = (t: Tally) => {
				const n = t.yes + t.no + t.unknown;
				return n === 0 ? "-" : `${Math.round((100 * t.yes) / n)}% (${t.yes}/${n}${t.unknown ? `, ${t.unknown} unknown` : ""})`;
			};
			const lines = [
				"| rule | tier | pairing answers with | pairing recall | Shieldstral recall | pairing FP | Shieldstral FP |",
				"| --- | --- | --- | --- | --- | --- | --- |",
			];
			for (const r of policy.entries) {
				const pair = tallies.get("qwen3guard")!.get(r.key)!;
				const shield = tallies.get("shieldstral")!.get(r.key)!;
				lines.push(
					`| ${r.key} | ${r.tier} | ${PAIRED.has(r.key) ? "Shieldstral" : "Qwen3Guard"} | ${pct(pair.own)} | ${pct(shield.own)} | ${pct(pair.benign)} | ${pct(shield.benign)} |`
				);
			}
			const table = lines.join("\n");
			console.log(`\n${table}\n`);
			if (env("CALIBRATION_OUT")) writeFileSync(env("CALIBRATION_OUT"), `${table}\n`);
			expect(lines.length).toBe(policy.entries.length + 2);
		},
		90 * 60 * 1000
	);
});
