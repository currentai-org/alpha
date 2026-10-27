import Root from './Root.svelte';
import Sidebar from './Sidebar.svelte';
import Main from './Main.svelte';
import SidePanel from './SidePanel.svelte';

export { getAppShell, type AppShellContext } from './context.svelte.ts';
/** Pattern: the application frame (chat-app layout). */
export const AppShell = { Root, Sidebar, Main, SidePanel };
