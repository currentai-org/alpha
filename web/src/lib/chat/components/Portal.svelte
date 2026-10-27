<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { getThemeContext } from "@aipotluck/alpha-ds";
	interface Props {
		children?: import("svelte").Snippet;
	}

	let { children }: Props = $props();

	let el: HTMLElement | undefined = $state();

	// Inside the chat window, portal into the design system's body-level theme host so the popup
	// keeps the window's tokens and light/dark mode; elsewhere, plain <body>.
	const theme = getThemeContext();

	onMount(() => {
		(theme?.portalTarget ?? el?.ownerDocument.body)?.appendChild(el!);
	});

	onDestroy(() => {
		if (el?.parentNode) {
			el.parentNode.removeChild(el);
		}
	});
</script>

<div bind:this={el} class="contents">
	{@render children?.()}
</div>
