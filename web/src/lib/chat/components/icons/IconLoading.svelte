<script lang="ts">
	interface Props {
		classNames?: string;
	}

	let { classNames = "" }: Props = $props();
</script>

<!-- Typing/thinking indicator: on-palette ink dots, sized so the pending
     answer bubble reads as a deliberate "typing…" affordance rather than an empty outline. -->
<div class={"inline-flex h-8 flex-none items-center gap-1.5 " + classNames}>
	<div
		class="size-1.5 flex-none animate-bounce rounded-full bg-[var(--ap-ink-3)]"
		style="animation-delay: 0.25s;"
	></div>
	<div
		class="size-1.5 flex-none animate-bounce rounded-full bg-[var(--ap-ink-3)]"
		style="animation-delay: 0.5s;"
	></div>
	<div
		class="size-1.5 flex-none animate-bounce rounded-full bg-[var(--ap-ink-3)]"
		style="animation-delay: 0.75s;"
	></div>
</div>
