#!/usr/bin/env node
// Patch coverage: of the lines a diff adds or changes in covered source, how many did the tests that
// ran execute (SOL-107). Global thresholds say little about a single PR; this says whether the
// PR's own new code was run by any test.
//
//   node scripts/patch-coverage.mjs <base> [coverage/coverage-final.json]
//
// Reads an istanbul JSON report (vitest's `json` coverage reporter) and `git diff -U0 <base>`.
// A changed line counts when a statement starts on it; blank lines, comments and types carry no
// statement and are left out. Prints one line per file with uncovered changed lines, then the
// total, and a GitHub `::warning::` when the total is under PATCH_COVERAGE_MIN (default 80).
// Exits 0 unless the report is missing, so it reports and never blocks.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [base, reportPath = "coverage/coverage-final.json"] = process.argv.slice(2);
if (!base) {
	console.error("usage: patch-coverage.mjs <base> [coverage-final.json]");
	process.exit(2);
}
const min = Number(process.env.PATCH_COVERAGE_MIN ?? 80);
const cwd = process.cwd();

if (!fs.existsSync(reportPath)) {
	console.error(`patch-coverage: no report at ${reportPath}`);
	process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

/** Changed line numbers per file, from the new side of each hunk header. */
const changed = new Map();
let file = null;
const diff = execFileSync("git", ["diff", "-U0", "--relative", "--no-color", base], { cwd, encoding: "utf8" });
for (const line of diff.split("\n")) {
	if (line.startsWith("+++ ")) {
		file = line === "+++ /dev/null" ? null : line.slice(6);
		continue;
	}
	const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
	if (!hunk || !file) continue;
	const start = Number(hunk[1]);
	const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
	if (!changed.has(file)) changed.set(file, new Set());
	for (let n = start; n < start + count; n++) changed.get(file).add(n);
}

let covered = 0;
let total = 0;
const misses = [];
for (const [abs, cov] of Object.entries(report)) {
	const rel = path.relative(cwd, abs);
	const lines = changed.get(rel);
	if (!lines) continue;
	// A line is covered when every statement starting on it ran at least once.
	const byLine = new Map();
	for (const [id, loc] of Object.entries(cov.statementMap)) {
		const n = loc.start.line;
		if (!lines.has(n)) continue;
		byLine.set(n, (byLine.get(n) ?? true) && cov.s[id] > 0);
	}
	const missed = [...byLine]
		.filter(([, ran]) => !ran)
		.map(([n]) => n)
		.sort((a, b) => a - b);
	total += byLine.size;
	covered += byLine.size - missed.length;
	if (missed.length)
		misses.push(`${rel}: ${missed.length} of ${byLine.size} changed lines never ran (${missed.join(", ")})`);
}

for (const m of misses) console.log(m);
if (!total) {
	console.log("patch-coverage: the diff changes no line the coverage report measures");
	process.exit(0);
}
const pct = (100 * covered) / total;
console.log(`patch-coverage: ${covered} of ${total} changed lines ran (${pct.toFixed(1)}%)`);
if (pct < min && process.env.GITHUB_ACTIONS) {
	console.log(
		`::warning title=Patch coverage::${covered} of ${total} changed lines ran (${pct.toFixed(1)}%), under ${min}%`
	);
}
