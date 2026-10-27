<script lang="ts">
	/** A point on a 1–5 scale drawn as rising bars, the first `value` filled. Decorative. */
	let { value, max = 5 }: { value: number; max?: number } = $props();
</script>

<span class="flex h-4 items-end gap-0.5" aria-hidden="true">
	{#each Array.from({ length: max }, (_, i) => i + 1) as n (n)}
		<span class="w-1 rounded-sharp {n <= value ? 'bg-fg-1' : 'bg-line-2'} {['h-1.5', 'h-2', 'h-2.5', 'h-3.5', 'h-4'][n - 1]}"
		></span>
	{/each}
</span>
