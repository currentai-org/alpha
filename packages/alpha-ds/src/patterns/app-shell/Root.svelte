<!--
  @component
  `AppShell.Root` — the app frame: persistent sidebar | conversation column | optional
  side panel. Owns sidebar-collapsed, mobile-drawer and side-panel state for its regions.

  ```svelte
  <AppShell.Root bind:collapsed>
    <AppShell.Sidebar>…</AppShell.Sidebar>
    <AppShell.Main>…</AppShell.Main>
    <AppShell.SidePanel>…</AppShell.SidePanel>
  </AppShell.Root>
  ```
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';
	import { setAppShell } from './context.svelte.ts';

	let {
		collapsed = $bindable(false),
		mobileOpen = $bindable(false),
		sidePanelOpen = $bindable(false),
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> & {
		collapsed?: boolean;
		mobileOpen?: boolean;
		sidePanelOpen?: boolean;
		children?: Snippet;
	} = $props();

	setAppShell({
		get collapsed() {
			return collapsed;
		},
		get mobileOpen() {
			return mobileOpen;
		},
		get sidePanelOpen() {
			return sidePanelOpen;
		},
		toggleSidebar() {
			collapsed = !collapsed;
		},
		setMobileOpen(open) {
			mobileOpen = open;
		},
		setSidePanelOpen(open) {
			sidePanelOpen = open;
		}
	});
</script>

<div
	{...rest}
	data-surface="1"
	data-sidebar={collapsed ? 'collapsed' : 'expanded'}
	class={cn(
		'relative isolate flex h-full min-h-0 w-full overflow-hidden bg-surface-1 text-fg-1',
		className
	)}
>
	{@render children?.()}
</div>
