#!/usr/bin/env node
/**
 * Alpha design system version + changelog. The version is derived from changelog entries
 * (packages/alpha-ds/src/version/ledger.ts), so the only thing to do after a change is record it:
 *
 *   pnpm ds:version                      current version, latest entries, anything unrecorded
 *   pnpm ds:version --check              exit 1 if a change is unrecorded (lint:design, CI)
 *   pnpm ds:change "<summary>"           record this branch's change; bump is worked out for you
 *   pnpm ds:change "<summary>" --bump=major    raise it (never lower than the surface demands)
 *
 * Two checks, both named for what they catch:
 *   surface  the public names in the code (dsLedger.mjs) equal what the changelog vouches for —
 *            an added or removed export, part, prop, variant, token, utility, theme or lint rule
 *            with no entry fails, in any checkout, with no git needed.
 *   branch   a branch that changed design-system source (not docs/examples/specs) added an entry.
 *            Needs the base ref (--base=, default origin/develop) or an explicit --range=A..B;
 *            when neither resolves it prints NOT RUN rather than passing silently.
 *
 * `ds:change` updates the entry this branch already added instead of stacking a second one, so a
 * branch lands as one changelog entry however many times it is run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	bumpRank,
	diffSurface,
	formatSurface,
	parseEntry,
	requiredBump,
} from "../../packages/alpha-ds/src/version/ledger.ts";
import { CHANGELOG_DIR, WEB, branchChanges, extractSurface, isVersionedPath, loadLedger } from "./lib/dsLedger.mjs";

const argv = process.argv.slice(2);
const flag = (name) =>
	argv
		.find((a) => a.startsWith(`--${name}=`))
		?.split("=")
		.slice(1)
		.join("=");
const has = (name) => argv.includes(`--${name}`);
const positional = argv.filter((a) => !a.startsWith("--"));
const command = positional[0] === "change" ? "change" : "status";

const base = flag("base") ?? process.env.DS_VERSION_BASE ?? "origin/develop";
const range = flag("range");

const ledger = loadLedger();
const surface = await extractSurface();
const drift = diffSurface(ledger.surface, surface);
const hasDrift = drift.added.length + drift.removed.length > 0;

/** Versioned files + entry ids for an explicit A..B range (CI: HEAD^1..HEAD is "this PR"). */
function rangeChanges(spec) {
	const run = (...a) => execFileSync("git", a, { cwd: WEB, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	try {
		const files = run("diff", "--name-only", spec).split("\n").filter(Boolean);
		const added = run("diff", "--name-only", "--diff-filter=A", spec).split("\n");
		return {
			base: spec,
			label: `in ${spec}`,
			versioned: files.filter(isVersionedPath),
			entries: added
				.filter((p) => /^packages\/alpha-ds\/src\/changelog\/[^/]+\.md$/.test(p) && !p.endsWith("README.md"))
				.map((p) => p.split("/").pop().slice(0, -3)),
		};
	} catch {
		return null;
	}
}

const branch = range
	? rangeChanges(range)
	: (() => {
			const b = branchChanges(base);
			return b && { ...b, label: `since ${base}` };
		})();

const indent = (lines, sign) => lines.map((l) => `    ${sign} ${l}`).join("\n");
const HOW =
	'  record it:  pnpm ds:change "<one line for someone building on the design system>"\n' +
	"  (the bump is worked out from the surface; the version follows from the changelog)";

if (command === "status") {
	const check = has("check");
	let failed = false;

	if (hasDrift) {
		failed = true;
		console.error("✗ surface: the design system changed without a changelog entry");
		if (drift.added.length) console.error(`  in the code, not in the changelog:\n${indent(drift.added, "+")}`);
		if (drift.removed.length) console.error(`  in the changelog, gone from the code:\n${indent(drift.removed, "-")}`);
		console.error(`  that needs at least a ${requiredBump(drift)} entry.\n${HOW}`);
	} else {
		console.log(`✓ surface: ${surface.size} public names, all recorded`);
	}

	if (!branch) {
		console.log(
			`• branch: NOT RUN — could not resolve ${range ?? base} (shallow clone or no remote). ` +
				"The surface check above still ran."
		);
	} else if (branch.versioned.length && !branch.entries.length) {
		failed = true;
		console.error(
			`✗ branch: ${branch.versioned.length} design-system file(s) changed ${branch.label}, no changelog entry added`
		);
		console.error(indent(branch.versioned.slice(0, 12), "~"));
		if (branch.versioned.length > 12) console.error(`    … and ${branch.versioned.length - 12} more`);
		console.error(HOW);
	} else if (branch.entries.length) {
		console.log(`✓ branch: recorded in ${branch.entries.map((e) => `changelog/${e}.md`).join(", ")}`);
	} else {
		console.log(`✓ branch: no design-system source changed ${branch.label}`);
	}

	if (!check) {
		console.log(`\nAlpha design system v${ledger.version}`);
		for (const r of ledger.releases.slice(0, 5))
			console.log(`  ${r.version.padEnd(8)} ${r.date}  ${r.bump.padEnd(5)}  ${r.summary}`);
	}
	process.exit(check && failed ? 1 : 0);
}

// ── change ─────────────────────────────────────────────────────────────────────────────────────
const summary = positional[1];
const asked = flag("bump");
if (!summary) {
	console.error('usage: pnpm ds:change "<summary>" [--bump=patch|minor|major]');
	process.exit(2);
}
if (asked && !["patch", "minor", "major"].includes(asked)) {
	console.error(`--bump must be patch, minor or major (got ${asked})`);
	process.exit(2);
}

const slugify = (s) =>
	s
		.toLowerCase()
		.replace(/[`'’"]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.split("-")
		.slice(0, 6)
		.join("-") || "change";

const own = branch?.entries.filter((id) => existsSync(join(CHANGELOG_DIR, `${id}.md`))) ?? [];
const existingId = own.length === 1 ? own[0] : undefined;
const existing = existingId
	? parseEntry(existingId, readFileSync(join(CHANGELOG_DIR, `${existingId}.md`), "utf8"))
	: undefined;

// Drift is measured against the whole ledger, which already includes this branch's own entry, so
// it is exactly what that entry is missing. Merge: a name added then removed again cancels out.
const added = new Set(existing?.surface.added ?? []);
const removed = new Set(existing?.surface.removed ?? []);
for (const s of drift.added) removed.has(s) ? removed.delete(s) : added.add(s);
for (const s of drift.removed) added.has(s) ? added.delete(s) : removed.add(s);
const delta = { added: [...added], removed: [...removed] };

const floor = requiredBump(delta);
const bumps = [floor, asked, existing?.bump].filter(Boolean);
const bump = bumps.reduce((a, b) => (bumpRank(b) > bumpRank(a) ? b : a));
if (asked && bumpRank(asked) < bumpRank(floor))
	console.warn(`! --bump=${asked} raised to ${floor}: the surface change needs it`);

const today = new Date().toISOString().slice(0, 10);
const id = existingId ?? `${today}-${slugify(summary)}`;
let notes = existing?.notes ?? "";
let entrySummary = summary;
if (existing && existing.summary !== summary) {
	// Keep the first summary as the headline; later runs add to the notes.
	entrySummary = existing.summary;
	if (!notes.includes(summary)) notes = `${notes}\n\n- ${summary}`.trim();
}

const text =
	`---\nbump: ${bump}\nsummary: ${entrySummary}\n---\n` +
	(notes ? `\n${notes}\n` : "") +
	(delta.added.length + delta.removed.length
		? `\n<!-- surface: written by \`pnpm ds:change\` — rerun it rather than editing by hand -->\n\n${formatSurface(delta)}`
		: "");

mkdirSync(CHANGELOG_DIR, { recursive: true });
const path = join(CHANGELOG_DIR, `${id}.md`);
writeFileSync(path, text);
parseEntry(id, text); // the file just written must parse, or fail here rather than in CI

const after = loadLedger();
console.log(
	`✓ ${existing ? "updated" : "wrote"} ${relative(WEB, path)} — ${bump}` +
		(delta.added.length ? `, +${delta.added.length}` : "") +
		(delta.removed.length ? `, -${delta.removed.length}` : "") +
		`\n  design system is now v${after.version}` +
		"\n  add detail for other agents under the frontmatter if the summary is not enough"
);
if (own.length > 1)
	console.warn(`! this branch already added ${own.length} entries; wrote a new one rather than guess`);
