<!--
  @component
  `Attachment.Row` — the files attached to one message, in one line that scrolls sideways. In the
  composer it sits inside the box above the text; in a sent message, above the message's text.

  ```svelte
  <Attachment.Row aria-label="Attached files">
    {#each files as file, i (i)}<Attachment.Card name={file.name} … />{/each}
  </Attachment.Row>
  ```
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { attachmentRowRecipe } from './attachment.recipe.ts';

	let {
		class: className,
		children,
		...rest
	}: {
		class?: string;
		children?: Snippet;
		'aria-label'?: string;
		[attr: `data-${string}`]: unknown;
	} = $props();
</script>

<div {...rest} class={cn(attachmentRowRecipe(), className)} data-attachment-row>
	{@render children?.()}
</div>
