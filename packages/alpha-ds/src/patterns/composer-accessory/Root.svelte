<!--
  @component
  `ComposerAccessory.Root` — pills attached to the composer that open context panels (Recursive's
  composer accessory row). Wrap the composer with it: a `Panel` renders in flow at the Root's full
  width, so every panel matches the input's width. One panel open at a time. A panel stays open
  while you use the rest of the app (menus, the sidebar, the conversation) — it closes from its
  close button, by pressing its pill again, or with Escape while focus is inside the composer.

  ```svelte
  <ComposerAccessory.Root>
    <ComposerAccessory.Panel value="privacy" label="Where your message goes">…</ComposerAccessory.Panel>
    <Composer.Root>…</Composer.Root>
    <ComposerAccessory.Row>
      <ComposerAccessory.Pill value="privacy" icon={RiShieldLine}>Private</ComposerAccessory.Pill>
    </ComposerAccessory.Row>
  </ComposerAccessory.Root>
  ```
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { on } from 'svelte/events';
	import { cn } from '../../internal/cn.ts';
	import { setComposerAccessory } from './context.ts';

	let {
		open = $bindable(null),
		class: className,
		children
	}: {
		/** The open panel's value, or null. Bindable. */
		open?: string | null;
		class?: string;
		children?: Snippet;
	} = $props();

	const baseId = $props.id();
	let root: HTMLDivElement | undefined = $state();

	setComposerAccessory({
		get open() {
			return open;
		},
		baseId,
		toggle(value) {
			open = open === value ? null : value;
		},
		close() {
			open = null;
		}
	});

	// No outside-click dismissal: opening the account menu or scrolling the chat shouldn't throw away
	// the panel you were reading. Escape still closes it, but only from inside the composer, so an
	// Escape meant for a menu or dialog elsewhere never reaches it.
	$effect(() => {
		if (open === null) return;
		return on(document, 'keydown', (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || e.defaultPrevented) return;
			if (root && e.target instanceof Node && root.contains(e.target)) open = null;
		});
	});
</script>

<div bind:this={root} class={cn('flex w-full flex-col', className)} data-composer-accessory>
	{@render children?.()}
</div>
