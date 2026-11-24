// Operator CLIs as plain Node scripts, so the published image runs them with `node` and ships no dev
// dependency. `pnpm build:operator-cli` writes build/cli/<name>.mjs; the Dockerfile runs it
// after `vite build`, and the image copies build/ whole.
//
// A vite SSR library build, not the app's config: SvelteKit's plugin would take the build over. The
// CLIs' import graph touches four SvelteKit virtual modules, shimmed in scripts/operator-cli/shims/.
// Vite expands import.meta.glob and import.meta.env as it does for the app. web/'s production
// dependencies stay imports, which the image's node_modules has; anything else the CLIs reach, such as
// @sveltejs/kit and dotenv (dev dependencies), is bundled into the script.
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { paraglideOptions } from './paraglide.config.js';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Each operator CLI: the name operators run (`node build/cli/<name>.mjs`) and its source. */
export const OPERATOR_CLIS = {
	'import-open-webui': 'scripts/import-open-webui.ts'
} as const;

const prodDependencies = new Set(
	Object.keys(JSON.parse(readFileSync(here('./package.json'), 'utf-8')).dependencies ?? {})
);
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const packageOf = (specifier: string) =>
	specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

/** Production dependencies stay imports, which the image's node_modules satisfies; the rest is bundled. */
const external = (id: string) =>
	!id.startsWith('.') &&
	!id.startsWith('/') &&
	!id.startsWith('\0') &&
	(builtins.has(id) || builtins.has(packageOf(id)) || prodDependencies.has(packageOf(id)));

export default defineConfig({
	mode: 'production',
	tsconfig: here('./scripts/operator-cli/tsconfig.json'),
	resolve: {
		alias: [
			{ find: /^\$lib(?=\/|$)/, replacement: here('./src/lib') },
			{ find: /^\$app\/env$/, replacement: here('./scripts/operator-cli/shims/app-env.ts') },
			{ find: /^\$app\/server$/, replacement: here('./scripts/operator-cli/shims/app-server.ts') },
			{
				find: /^\$env\/dynamic\/private$/,
				replacement: here('./scripts/operator-cli/shims/env-dynamic-private.ts')
			},
			{
				find: /^\$env\/dynamic\/public$/,
				replacement: here('./scripts/operator-cli/shims/env-dynamic-public.ts')
			}
		]
	},
	ssr: { noExternal: true },
	// The app build compiles $lib/paraglide/ (gitignored); this build compiles it too, so it runs in any order.
	plugins: [paraglideVitePlugin(paraglideOptions)],
	build: {
		ssr: true,
		target: 'node24',
		outDir: here('./build/cli'),
		emptyOutDir: true,
		minify: false,
		sourcemap: true,
		copyPublicDir: false,
		rollupOptions: {
			external,
			input: Object.fromEntries(
				Object.entries(OPERATOR_CLIS).map(([name, src]) => [name, here(`./${src}`)])
			),
			output: {
				format: 'esm',
				entryFileNames: '[name].mjs',
				chunkFileNames: 'chunks/[name]-[hash].mjs'
			}
		}
	}
});
