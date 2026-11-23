// Reads the installation's identity file for src/lib/deployment.ts: the JSON file DEPLOYMENT_CONFIG
// names, else config/deployment.json, both relative to web/. No file is an empty object, and every
// key then takes its neutral default in deployment.ts. Plain JS so sveltekit.config.js can read it too.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The file's values, or `{}` when there is none. A DEPLOYMENT_CONFIG that names a missing file throws.
 * @param {Record<string, string | undefined>} [env]
 */
export function readDeploymentFile(env = process.env) {
	const { named, path } = deploymentFilePath(env);
	if (!existsSync(path)) {
		if (named) throw new Error(`DEPLOYMENT_CONFIG="${named}" names no file (looked for ${path})`);
		return {};
	}
	const value = JSON.parse(readFileSync(path, 'utf-8'));
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${path} must hold a JSON object`);
	}
	return value;
}

/**
 * Which file is the identity file: DEPLOYMENT_CONFIG's, else config/deployment.json, resolved against
 * web/. `named` is the DEPLOYMENT_CONFIG value, or undefined when it is unset.
 * @param {Record<string, string | undefined>} [env]
 */
export function deploymentFilePath(env = process.env) {
	const named = env.DEPLOYMENT_CONFIG?.trim() || undefined;
	return { named, path: resolve(webDir, named || 'config/deployment.json') };
}
