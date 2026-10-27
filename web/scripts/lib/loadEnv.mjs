import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal dotenv-shaped file loader for standalone scripts run outside SvelteKit/Vite (which
 * wouldn't inject a plain `.env`/`.env.local` into process.env by itself). Fills only gaps — an
 * already-set value (a real shell export, a CI job, or `doppler run` injecting prod creds) always
 * wins over the file, so a later loadEnv(".env.local") call layers on top of an earlier
 * loadEnv(".env") without clobbering it.
 */
export function loadEnv(root, rel) {
	let raw;
	try {
		raw = readFileSync(resolve(root, rel), "utf8");
	} catch {
		return;
	}
	for (const line of raw.split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (!m) continue;
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		if (v !== "" && process.env[m[1]] === undefined) process.env[m[1]] = v;
	}
}
