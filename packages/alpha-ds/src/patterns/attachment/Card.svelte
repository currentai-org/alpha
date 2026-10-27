<!--
  @component
  `Attachment.Card` — one file attached to a message: a square thumbnail for a photo, otherwise a
  card with the file's type above its name. Opens a preview when `onopen` is set; a remove button
  sits in its top corner when `onremove` is set, shown on hover and focus (always where there is
  no hover).

  ```svelte
  <Attachment.Row>
    <Attachment.Card name="receipt.jpg" imageSrc={url} onremove={() => remove(0)} />
    <Attachment.Card name="notes.pdf" kind="PDF" onopen={preview} onremove={() => remove(1)} />
  </Attachment.Row>
  ```
-->
<script lang="ts">
	import type { Component } from 'svelte';
	import RiFileTextLine from '~icons/ri/file-text-line';
	import RiCloseLine from '~icons/ri/close-line';
	import { buttonRecipe } from '../../components/button/button.recipe.ts';
	import Spinner from '../../components/spinner/Spinner.svelte';
	import { cn } from '../../internal/cn.ts';
	import { attachmentCardRecipe } from './attachment.recipe.ts';

	let {
		name,
		kind,
		imageSrc,
		icon: Icon = RiFileTextLine,
		busy = false,
		busyLabel = 'Preparing',
		onopen,
		openLabel,
		onremove,
		removeLabel,
		class: className,
		...rest
	}: {
		/** File name. The card's text, the photo's alt text, and the default accessible names. */
		name: string;
		/** Type shown above the name on a file card ("PDF", "Text"). */
		kind?: string;
		/** A photo's thumbnail. Set, the card is a square image. */
		imageSrc?: string;
		/** Remix icon before the type on a file card. */
		icon?: Component;
		/** Still being prepared: a spinner covers the card. */
		busy?: boolean;
		/** Accessible name of that spinner. */
		busyLabel?: string;
		/** Makes the card a button that opens a preview. */
		onopen?: () => void;
		/** Accessible name of that button. Defaults to `Open <name>`. */
		openLabel?: string;
		/** Shows the remove button. */
		onremove?: () => void;
		/** Accessible name of the remove button. Defaults to `Remove <name>`. */
		removeLabel?: string;
		class?: string;
		[attr: `data-${string}`]: unknown;
	} = $props();

	const isImage = $derived(!!imageSrc);
</script>

{#snippet content()}
	{#if imageSrc}
		<img src={imageSrc} alt={name} class="block size-full object-cover" />
	{:else}
		<span class="flex size-full flex-col justify-between gap-0.5 px-3 py-1.5 text-left">
			<span class="flex min-w-0 items-center gap-1.5 type-caption text-fg-2">
				<Icon aria-hidden="true" class="size-3.5 shrink-0 text-fg-3" />
				{#if kind}<span class="truncate">{kind}</span>{/if}
			</span>
			<span class="line-clamp-2 type-caption wrap-anywhere text-fg-1" title={name}>{name}</span>
		</span>
	{/if}
{/snippet}

<div
	{...rest}
	class={cn(attachmentCardRecipe(), className)}
	data-attachment={isImage ? 'image' : 'file'}
	data-busy={busy ? '' : undefined}
>
	{#if onopen}
		<button
			type="button"
			class="block size-full cursor-pointer text-inherit"
			aria-label={openLabel ?? `Open ${name}`}
			onclick={(event) => {
				event.stopPropagation();
				onopen();
			}}
		>
			{@render content()}
		</button>
		<span
			aria-hidden="true"
			class="pointer-events-none absolute inset-0 transition-control group-hover/attachment:tint-hover"
		></span>
	{:else}
		{@render content()}
	{/if}
	{#if busy}
		<span class="absolute inset-0 grid place-items-center bg-surface-raised/80">
			<Spinner size="sm" label={busyLabel} />
		</span>
	{/if}
	{#if onremove}
		<button
			type="button"
			class={cn(
				buttonRecipe({ variant: 'secondary', size: 'icon-xs', shape: 'pill' }),
				'absolute top-1 right-1 z-10 opacity-0 group-hover/attachment:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100'
			)}
			aria-label={removeLabel ?? `Remove ${name}`}
			title={removeLabel ?? `Remove ${name}`}
			onclick={(event) => {
				event.preventDefault();
				event.stopPropagation();
				onremove();
			}}
		>
			<RiCloseLine aria-hidden="true" />
		</button>
	{/if}
</div>
