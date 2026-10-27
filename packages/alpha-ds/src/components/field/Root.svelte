<!--
  @component
  Base UI `Field.Root` — groups a label, control, description and error, and wires ids, aria and
  state between them.
-->
<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';
	import { untrack } from 'svelte';
	import { setFieldContext } from '../../internal/field-context.ts';

	let {
		disabled = false,
		invalid = false,
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLDivElement> & { disabled?: boolean; invalid?: boolean } = $props();

	const uid = $props.id();
	let descriptions = $state(0);
	let errors = $state(0);

	setFieldContext({
		controlId: `${uid}-control`,
		descriptionId: `${uid}-description`,
		errorId: `${uid}-error`,
		get disabled() {
			return disabled;
		},
		get invalid() {
			return invalid;
		},
		get hasDescription() {
			return descriptions > 0;
		},
		get hasError() {
			return errors > 0 && invalid;
		},
		// Called from the parts' $effects: untracked, or the count they write would re-run the effect
		// that wrote it (an infinite loop; scripts/alpha-ds-probe.mjs checks /designsystem/field).
		registerDescription() {
			untrack(() => descriptions++);
			return () => untrack(() => descriptions--);
		},
		registerError() {
			untrack(() => errors++);
			return () => untrack(() => errors--);
		}
	});
</script>

<div
	{...rest}
	class={cn('flex flex-col gap-1.5', className)}
	data-disabled={disabled ? '' : undefined}
	data-invalid={invalid ? '' : undefined}
>
	{@render children?.()}
</div>
