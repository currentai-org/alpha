// Content scans run ripgrep with PCRE2, whose match limit is exceeded on a single multi-megabyte line.
// For each JSON file over 1 MB that holds a line over 1 MB, write a pretty-printed copy of it to
// <dest> at the same relative path, so the export's scans can read it line by line. The exporter scans
// the copy instead of the original, so a hit in such a file is still found and keeps the original's path.
// Prints the relative paths it expanded, one per line.
//
//   node expand-huge-json.mjs <export-dir> <dest-dir>
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const [root, dest] = process.argv.slice(2);
if (!root || !dest) {
	console.error('usage: expand-huge-json.mjs <export-dir> <dest-dir>');
	process.exit(2);
}
const LIMIT = 1_000_000;

function* walk(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else if (e.isFile() && e.name.endsWith('.json')) yield p;
	}
}

for (const file of walk(root)) {
	if (statSync(file).size <= LIMIT) continue;
	const text = readFileSync(file, 'utf8');
	if (!text.split('\n').some((l) => l.length > LIMIT)) continue;
	let out;
	try {
		out = JSON.stringify(JSON.parse(text), null, 1);
	} catch {
		// Not valid JSON: break long lines at commas so the scan can still read them.
		out = text.replace(/,/g, ',\n');
	}
	const rel = relative(root, file);
	mkdirSync(dirname(join(dest, rel)), { recursive: true });
	writeFileSync(join(dest, rel), out);
	console.log(rel);
}
