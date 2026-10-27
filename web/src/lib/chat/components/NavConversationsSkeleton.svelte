<script lang="ts">
	interface Props {
		rows?: number;
	}

	let { rows = 4 }: Props = $props();
</script>

<div class="mt-3 flex flex-col gap-3 border-t border-[var(--ap-rule)] pt-3" aria-hidden="true">
	<div class="h-[30px] w-20 animate-pulse rounded bg-[var(--ap-rule)]/60"></div>
	{#each Array.from({ length: rows }) as _, i (i)}
		<div class="h-9 w-full animate-pulse rounded bg-[var(--ap-rule)]/40"></div>
	{/each}
</div>
