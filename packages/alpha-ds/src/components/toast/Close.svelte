<!--
  @component
  Base UI `Toast.Close` — icon-only ghost close, top-right.
-->
<script lang="ts">
	import RiCloseLine from '~icons/ri/close-line';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe } from '../button/button.recipe.ts';

	let { onclick, class: className }: { onclick?: () => void; class?: string } = $props();
</script>

<button
	type="button"
	aria-label="Dismiss notification"
	{onclick}
	class={cn(
		buttonRecipe({ variant: 'ghost', size: 'icon-xs' }),
		'absolute top-2 right-2',
		className
	)}
>
	<RiCloseLine aria-hidden="true" />
</button>
