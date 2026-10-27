#!/usr/bin/env node
/**
 * Design-lint ratchet for the Alpha product surface that predates the design system.
 *
 *   pnpm lint:design            fail if any file got WORSE than its baseline (per rule)
 *   pnpm lint:design --update   rewrite the baseline to today's (lower) counts
 *   pnpm lint:design --report   print the per-rule totals and the worst files
 *
 * New code built on the system is linted strictly by `pnpm lint` (DESIGN_SYSTEM_STRICT in
 * eslint.config.js). Legacy chat code gets every alpha-ds rule here, as a count that may only go
 * down: touching a legacy file never forces a full migration, but it can never add a violation.
 * When a file reaches zero, move it into DESIGN_SYSTEM_STRICT.
 */
import { ESLint } from "eslint";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import alphaDs, { rules } from "../eslint-rules/alpha-ds/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(root, "design-lint-baseline.json");
const argv = process.argv.slice(2);
const args = new Set(argv.filter((a) => a.startsWith("--")));

/** The Alpha product surface still on legacy styling. */
const LEGACY = ["src/lib/chat", "src/routes/chat", "src/lib/alpha-landing", "src/routes/alpha"];
const patterns = LEGACY.map((p) => `${p}/**/*.{svelte,ts}`);

// File arguments (lint-staged passes the staged files) check only those files against their baseline
// counts, so a regression fails the commit instead of the PR's CI. The baseline can't be rewritten
// from a partial count.
const only = argv
	.filter((a) => !a.startsWith("--"))
	.map((f) => relative(root, resolve(f)))
	.filter((f) => LEGACY.some((p) => f.startsWith(p + "/")) && !/\.(spec|test)\.ts$/.test(f));
if (argv.some((a) => !a.startsWith("--")) && only.length === 0) process.exit(0);
if (only.length && (args.has("--update") || args.has("--report"))) {
	console.error("✗ --update and --report read every legacy file; run them without file arguments.");
	process.exit(2);
}

// Only the alpha-ds rules run, and none of them reads type information, so the type-aware parse
// eslint.config.js sets up for `pnpm lint` is switched off here. Running the whole config and
// keeping the alpha-ds messages cost 56s and 2GB for the same counts (CUR-2583).
const eslint = new ESLint({
	cwd: root,
	ruleFilter: ({ ruleId }) => ruleId.startsWith("alpha-ds/"),
	overrideConfig: [
		{
			files: patterns,
			ignores: ["**/*.spec.ts", "**/*.test.ts"],
			plugins: { "alpha-ds": alphaDs },
			languageOptions: { parserOptions: { projectService: false } },
			rules: Object.fromEntries(Object.keys(rules).map((r) => [`alpha-ds/${r}`, "warn"])),
		},
	],
});

const results = await eslint.lintFiles(only.length ? only : patterns);
/** @type {Record<string, Record<string, number>>} */
const current = {};
for (const r of results) {
	for (const m of r.messages) {
		if (!m.ruleId?.startsWith("alpha-ds/")) continue;
		const file = relative(root, r.filePath);
		current[file] ??= {};
		current[file][m.ruleId] = (current[file][m.ruleId] ?? 0) + 1;
	}
}

const sortObj = (o) =>
	Object.fromEntries(
		Object.keys(o)
			.sort()
			.map((k) => [k, typeof o[k] === "object" ? sortObj(o[k]) : o[k]])
	);
const total = (o) => Object.values(o).reduce((a, f) => a + Object.values(f).reduce((x, y) => x + y, 0), 0);

if (args.has("--report")) {
	const byRule = {};
	for (const f of Object.values(current))
		for (const [rule, n] of Object.entries(f)) byRule[rule] = (byRule[rule] ?? 0) + n;
	console.log(`Design-lint debt: ${total(current)} violations in ${Object.keys(current).length} files\n`);
	for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1]))
		console.log(`  ${String(n).padStart(5)}  ${rule}`);
	console.log("\nWorst files:");
	Object.entries(current)
		.map(([f, rs]) => [f, Object.values(rs).reduce((a, b) => a + b, 0)])
		.sort((a, b) => b[1] - a[1])
		.slice(0, 15)
		.forEach(([f, n]) => console.log(`  ${String(n).padStart(5)}  ${f}`));
	process.exit(0);
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;

if (args.has("--update") || !baseline) {
	if (baseline && !args.has("--force")) {
		const worse = regressions(baseline, current);
		if (worse.length) {
			console.error("✗ Refusing to raise the baseline. Fix these, or pass --force with a reason in the commit:");
			worse.forEach((w) => console.error("  " + w));
			process.exit(1);
		}
	}
	writeFileSync(baselinePath, JSON.stringify(sortObj(current), null, "\t") + "\n");
	console.log(`✓ baseline written: ${total(current)} violations in ${Object.keys(current).length} files`);
	process.exit(0);
}

function regressions(base, now) {
	const out = [];
	for (const [file, rulesNow] of Object.entries(now)) {
		for (const [rule, n] of Object.entries(rulesNow)) {
			const was = base[file]?.[rule] ?? 0;
			if (n > was) out.push(`${file}  ${rule}: ${was} → ${n}`);
		}
	}
	return out;
}

const worse = regressions(baseline, current);
const before = total(baseline);
const after = total(current);
if (only.length) {
	if (worse.length) {
		console.error(`✗ Design-lint regressions in staged files (legacy files may only get better):`);
		worse.forEach((w) => console.error("  " + w));
		console.error("\nUse design-system tokens/components instead — see /designsystem/linting.");
		process.exit(1);
	}
	process.exit(0);
}
if (worse.length) {
	console.error(`✗ Design-lint regressions (legacy files may only get better):`);
	worse.forEach((w) => console.error("  " + w));
	console.error("\nUse design-system tokens/components instead — see /designsystem/linting.");
	process.exit(1);
}
console.log(
	`✓ design lint: ${after} legacy violations (baseline ${before})${after < before ? " — run `pnpm lint:design --update` to lock in the improvement" : ""}`
);
