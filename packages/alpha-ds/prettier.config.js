// web/.prettierrc, with its plugins and Tailwind stylesheet resolved from web/, since this package
// installs neither (CUR-4479).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const web = new URL('../../web/', import.meta.url);
const base = JSON.parse(readFileSync(new URL('.prettierrc', web), 'utf8'));
const require = createRequire(new URL('package.json', web));

export default {
	...base,
	plugins: base.plugins.map((p) => require.resolve(p)),
	tailwindStylesheet: new URL(base.tailwindStylesheet, web).pathname
};
