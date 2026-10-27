<!--
  @component
  Base UI `Field.Description` — helper text, linked to the control via aria-describedby.
-->
<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';
	import { getFieldContext } from '../../internal/field-context.ts';

	let { class: className, children, ...rest }: HTMLAttributes<HTMLParagraphElement> = $props();
	const field = getFieldContext();
	$effect(() => field?.registerDescription());
</script>

<p id={field?.descriptionId} {...rest} class={cn('type-caption text-fg-3', className)}>
	{@render children?.()}
</p>
