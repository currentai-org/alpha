import { getContext, setContext } from 'svelte';

/**
 * Shell state shared by the shell's regions. Desktop: the sidebar collapses to an icon rail.
 * Mobile (< md): the sidebar is an off-canvas drawer, and `mobileOpen` drives it.
 */
export interface AppShellContext {
	readonly collapsed: boolean;
	readonly mobileOpen: boolean;
	readonly sidePanelOpen: boolean;
	toggleSidebar(): void;
	setMobileOpen(open: boolean): void;
	setSidePanelOpen(open: boolean): void;
}

const KEY = Symbol('alpha-ds.app-shell');
export const setAppShell = (ctx: AppShellContext) => setContext(KEY, ctx);
export function getAppShell(): AppShellContext {
	return (
		getContext<AppShellContext | undefined>(KEY) ?? {
			collapsed: false,
			mobileOpen: false,
			sidePanelOpen: false,
			toggleSidebar() {},
			setMobileOpen() {},
			setSidePanelOpen() {}
		}
	);
}
