<script lang="ts">
	import { base } from "$lib/chat/paths";
	import { afterNavigate } from "$app/navigation";
	import { useSettingsStore } from "$lib/chat/stores/settings";
	import { settingsReturnTo } from "$lib/chat/settingsSections";
	import RiCheckLine from "~icons/ri/check-line";

	interface Props {
		children?: import("svelte").Snippet;
	}

	let { children }: Props = $props();

	// Settings is a state of the app, not a modal over it: the page fills the main
	// column and the sidebar swaps to the section list with "Back to app" (NavMenu). This records
	// where "Back to app" returns to — the last non-settings URL.
	afterNavigate(({ from }) => {
		if (from?.url && !from.url.pathname.includes("/settings")) {
			settingsReturnTo.set(from.url.pathname + from.url.search);
		} else if (!$settingsReturnTo) {
			settingsReturnTo.set(`${base}/`);
		}
	});

	const settings = useSettingsStore();
</script>

<div class="relative flex h-full min-h-0 w-full flex-col" data-settings-view>
	{@render children?.()}
	{#if $settings.recentlySaved}
		<div
			role="status"
			class="absolute right-4 bottom-4 flex items-center gap-1.5 border border-line-2 bg-surface-raised px-3 py-1 type-caption text-fg-1 shadow-popover"
		>
			<RiCheckLine aria-hidden="true" class="size-3.5" />
			Saved
		</div>
	{/if}
</div>
