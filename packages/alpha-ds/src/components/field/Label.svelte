<!--
  @component
  Base UI `Field.Label` — a `<label>` bound to the field's control.
-->
<script lang="ts">
	import type { HTMLLabelAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';
	import { getFieldContext } from '../../internal/field-context.ts';

	let { class: className, children, ...rest }: HTMLLabelAttributes = $props();
	const field = getFieldContext();
</script>

<label
	for={field?.controlId}
	{...rest}
	class={cn('type-label text-fg-2 ui-disabled:opacity-40', className)}
	data-disabled={field?.disabled ? '' : undefined}
>
	{@render children?.()}
</label>
