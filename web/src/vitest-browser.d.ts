// Custom commands registered on the `client` vitest project (vite.config.ts), for specs that run in
// the browser.
declare module 'vitest/browser' {
	interface BrowserCommands {
		/** Emulates `prefers-reduced-motion: reduce` (true) or `no-preference` (false). */
		setReducedMotion: (reduce: boolean) => Promise<void>;
	}
}

export {};
