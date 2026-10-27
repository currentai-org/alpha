// web/'s ESLint config, run from here. ESLint lints nothing outside the directory it runs in, so
// web's own `pnpm lint` calls this one (CUR-4479). The design-system blocks in web/eslint.config.js
// name their files relative to this package.
export { default } from '../../web/eslint.config.js';
