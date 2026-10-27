<!--
  Test harness: NavConversationItem renders a Sidebar.Item, which uses the design system's Tooltip
  for its collapsed-rail label — and that needs the provider ThemeProvider mounts. Wrapping here
  rather than in each test keeps the cases about the marker.
-->
<script lang="ts">
	import { ThemeProvider } from '@aipotluck/alpha-ds';
	import type { ConvSidebar } from '$lib/chat/types/ConvSidebar';
	import NavConversationItem from './NavConversationItem.svelte';

	let { conv }: { conv: ConvSidebar } = $props();
</script>

<ThemeProvider mode="dark" theme="alpha">
	<ul class="w-64">
		<NavConversationItem {conv} readOnly />
	</ul>
</ThemeProvider>
