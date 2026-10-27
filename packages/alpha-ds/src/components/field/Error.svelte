<!--
  @component
  Base UI `Field.Error` — shown only while the field is invalid; announced politely.
-->
<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';
	import { getFieldContext } from '../../internal/field-context.ts';

	let {
		forceShow = false,
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLParagraphElement> & { forceShow?: boolean } = $props();
	const field = getFieldContext();
	$effect(() => field?.registerError());
</script>

{#if forceShow || field?.invalid}
	<p
		id={field?.errorId}
		role="alert"
		aria-live="polite"
		{...rest}
		class={cn('type-caption text-accent-2-text', className)}
	>
		{@render children?.()}
	</p>
{/if}
