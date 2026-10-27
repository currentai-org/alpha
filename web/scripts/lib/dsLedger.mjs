/**
 * Node side of the design-system version ledger: read `changelog/*.md`, extract the public
 * surface from the code, and find which files a branch changed. Pure folding lives in
 * packages/alpha-ds/src/version/ledger.ts, imported directly (type stripping), so there is one copy.
 *
 * The surface is every name a consumer or an extender can depend on, one line each:
 *
 *   export Button            value exported from the barrel (index.ts)
 *   type ButtonVariants      type exported from the barrel
 *   part Dialog.Popup        documented part (<slug>.docs.ts)
 *   prop Dialog.Popup.size   documented prop on a part
 *   variant button.buttonRecipe.size=sm   recipe variant value (*.recipe.ts)
 *   token --ds-surface-1     CSS custom property (tokens/generated/manifest.json)
 *   utility scroll-fade-y    hand-authored @utility (tokens/utilities.css)
 *   theme alpha              built-in theme id (tokens/themes.ts)
 *   rule alpha-ds/no-raw-colors   lint rule (eslint-rules/alpha-ds)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { foldLedger } from "../../../packages/alpha-ds/src/version/ledger.ts";

export const WEB = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ROOT = resolve(WEB, "..");
// The design system is the workspace package @aipotluck/alpha-ds; its lint rules stay in web/. (CUR-4479)
const DS_PATH = "packages/alpha-ds/src/";
export const DS = join(ROOT, DS_PATH);
export const CHANGELOG_DIR = join(DS, "changelog");
const RULES_DIR = join(WEB, "eslint-rules/alpha-ds");

/** `{ '<id>': '<raw md>' }` for every entry, keyed the way ledger.ts expects. */
export function readLedgerFiles() {
	if (!existsSync(CHANGELOG_DIR)) return {};
	return Object.fromEntries(
		readdirSync(CHANGELOG_DIR)
			.filter((f) => f.endsWith(".md") && f !== "README.md")
			.map((f) => [f.slice(0, -3), readFileSync(join(CHANGELOG_DIR, f), "utf8")])
	);
}

export const loadLedger = () => foldLedger(readLedgerFiles());

const LAYERS = ["components", "primitives", "patterns"];
const folders = (layer) => readdirSync(join(DS, layer)).filter((f) => statSync(join(DS, layer, f)).isDirectory());
const importTs = (path) => import(pathToFileURL(path).href);

/** Every public name, as a sorted Set of surface lines (see the header for the vocabulary). */
export async function extractSurface() {
	const out = new Set();

	// Barrel: `export { A, type B, C as D } from '…'` blocks.
	const barrel = readFileSync(join(DS, "index.ts"), "utf8");
	for (const [, names] of barrel.matchAll(/^export\s*\{([^}]*)\}\s*from/gm)) {
		for (let name of names
			.split(",")
			.map((n) => n.trim())
			.filter(Boolean)) {
			const isType = name.startsWith("type ");
			if (isType) name = name.slice(5).trim();
			name = name.split(/\s+as\s+/).pop();
			out.add(`${isType ? "type" : "export"} ${name}`);
		}
	}

	for (const layer of LAYERS) {
		for (const folder of folders(layer)) {
			const docsPath = join(DS, layer, folder, `${folder}.docs.ts`);
			if (existsSync(docsPath)) {
				const entry = (await importTs(docsPath)).default;
				for (const part of entry.parts ?? []) {
					out.add(`part ${part.name}`);
					for (const prop of part.props ?? []) out.add(`prop ${part.name}.${prop.name}`);
				}
			}
			const recipePath = join(DS, layer, folder, `${folder}.recipe.ts`);
			if (existsSync(recipePath)) {
				for (const [name, recipe] of Object.entries(await importTs(recipePath))) {
					for (const [key, values] of Object.entries(recipe?.variants ?? {})) {
						for (const v of Object.keys(values)) out.add(`variant ${folder}.${name}.${key}=${v}`);
					}
				}
			}
		}
	}

	const manifest = JSON.parse(readFileSync(join(DS, "tokens/generated/manifest.json"), "utf8"));
	for (const t of manifest.tokens) out.add(`token ${t}`);

	const utilities = readFileSync(join(DS, "tokens/utilities.css"), "utf8");
	for (const [, name] of utilities.matchAll(/^@utility\s+([\w-]+)/gm)) out.add(`utility ${name}`);

	const { themes } = await importTs(join(DS, "tokens/themes.ts"));
	for (const t of themes) out.add(`theme ${t.id}`);

	// Rule names from the plugin's rules/ folder rather than importing index.js, which itself
	// imports this ledger for its meta.version.
	for (const f of readdirSync(join(RULES_DIR, "rules"))) {
		if (f.endsWith(".js") && !f.includes(".spec.") && !f.includes(".test.")) out.add(`rule alpha-ds/${f.slice(0, -3)}`);
	}

	return new Set([...out].sort());
}

/**
 * Repo-relative files that count as a change to the design system. Docs, examples, specs and the catalog UI
 * describe the system without changing it, so they never need a changelog entry.
 */
export function isVersionedPath(p) {
	if (p.startsWith("web/eslint-rules/alpha-ds/")) return !/\.(spec|test)\.[jt]s$/.test(p);
	if (!p.startsWith(DS_PATH)) return false;
	const rel = p.slice(DS_PATH.length);
	if (/^(catalog|docs|changelog|version)\//.test(rel)) return false;
	if (/\/examples\//.test(rel)) return false;
	if (/\.(docs|spec|test)\.ts$/.test(rel) || rel.endsWith(".md")) return false;
	return true;
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const SCOPE = ["--", DS_PATH, "web/eslint-rules/alpha-ds/"];

/**
 * What this branch changed relative to `base`, working tree included. Returns null when the base
 * cannot be resolved (shallow clone, no remote) — callers must say so, never read it as "clean".
 */
export function branchChanges(base) {
	let mergeBase;
	try {
		mergeBase = git("merge-base", "HEAD", base).trim();
	} catch {
		return null;
	}
	const changed = git("diff", "--name-only", mergeBase, ...SCOPE)
		.split("\n")
		.filter(Boolean);
	const added = git("diff", "--name-only", "--diff-filter=A", mergeBase, ...SCOPE)
		.split("\n")
		.filter(Boolean);
	const untracked = git("ls-files", "--full-name", "--others", "--exclude-standard", ...SCOPE)
		.split("\n")
		.filter(Boolean);
	const all = [...new Set([...changed, ...untracked])];
	const entryIds = [...added, ...untracked]
		.filter((p) => p.startsWith(`${DS_PATH}changelog/`) && p.endsWith(".md"))
		.map((p) => p.split("/").pop().slice(0, -3))
		.filter((id) => id !== "README");
	return {
		base,
		mergeBase,
		versioned: all.filter(isVersionedPath).sort(),
		entries: [...new Set(entryIds)].sort(),
	};
}
