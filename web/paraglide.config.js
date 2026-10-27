/** @type {import('@inlang/paraglide-js').CompilerOptions} */
export const paraglideOptions = {
	project: './project.inlang',
	outdir: './src/lib/paraglide',
	emitTsDeclarations: true,
	// Which language a request is in is decided once, in src/lib/i18n/routing.ts, and handed to
	// Paraglide through this custom strategy (server: per request; browser: a reactive value).
	strategy: ['custom-interface', 'baseLocale']
};
