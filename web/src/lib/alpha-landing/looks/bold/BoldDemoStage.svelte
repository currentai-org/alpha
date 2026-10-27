<!--
  @component
  /alpha/demo in the bold look: the real app as a square-cornered window on the navy pattern field,
  with a slim footer that names the demo, offers Exit, and puts Try Alpha in coral beside it.
-->
<script lang="ts">
	import './bold.css';
	import type { Component } from 'svelte';
	import { m } from '$lib/paraglide/messages.js';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import RiCloseLine from '~icons/ri/close-line';
	import BoldPatternField from './BoldPatternField.svelte';
	import PatternGlyph from './PatternGlyph.svelte';

	let { DemoClient, onexit }: { DemoClient: Component | null; onexit: () => void } = $props();
</script>

<!-- The stage stays a plain dark token scope (see routes/alpha/demo), with the bold look's colour
     variables on top for the field and the footer. -->
<div
	class="ds-root bold-look bold-demo-stage fixed inset-0 flex flex-col gap-3 bg-dark-blue p-3 md:gap-4 md:p-5"
	data-ds-theme="alpha"
	data-mode="dark"
	data-demo-mode
>
	<BoldPatternField mask="open" />

	<div class="demo-window relative z-[1] min-h-0 flex-1 overflow-hidden" data-demo-window>
		{#if DemoClient}
			<DemoClient />
		{:else}
			<div
				class="grid h-full place-items-center bg-surface-1 font-mono text-[12px] tracking-[0.16em] text-fg-3 uppercase"
				aria-busy="true"
			>
				Loading the demo…
			</div>
		{/if}
	</div>

	<div
		class="relative z-[1] mx-auto flex w-full max-w-3xl shrink-0 items-stretch gap-2"
		data-demo-footer
	>
		<div
			class="flex min-w-0 flex-1 items-center gap-3 bg-dark-blue py-1.5 pr-1.5 pl-1.5 text-white ring-1 ring-white/15"
			data-demo-bar
		>
			<span class="relative ml-1.5 size-6 shrink-0 overflow-hidden" aria-hidden="true">
				<PatternGlyph concept="language" cell={2} />
			</span>
			<span
				class="min-w-0 flex-1 truncate font-mono text-[12px] tracking-[0.16em] text-white/70 uppercase"
				>{m.chat_demoBarSample()}</span
			>
			<button
				type="button"
				class="inline-flex h-9 items-center gap-1.5 px-3 font-jakarta text-[14px] font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white"
				onclick={onexit}
				aria-label={m.chat_exitDemo()}
				data-exit-demo
			>
				<RiCloseLine aria-hidden="true" class="size-4" />
				{m.chat_exit()}
			</button>
		</div>
		<!-- eslint-disable svelte/no-navigation-without-resolve -- /chat is the CMS chat page, not a typed file route -->
		<a
			href="/chat"
			class="group inline-flex shrink-0 items-stretch bg-(--bold-coral) font-jakarta text-[15px] font-bold text-white"
			data-demo-try-alpha
		>
			<span class="flex items-center px-4">{m.chat_tryAlpha()}</span>
			<span
				class="flex w-12 items-center justify-center bg-dark-blue/10 transition-colors group-hover:bg-dark-blue group-hover:text-(--bold-coral)"
			>
				<ArrowRightIcon class="size-4" strokeWidth={2.5} aria-hidden="true" />
			</span>
		</a>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</div>
</div>

<style>
	.demo-window {
		box-shadow:
			0 0 0 1px rgb(255 255 255 / 0.14),
			0 50px 120px -40px rgb(0 0 0 / 0.7);
		view-transition-name: alpha-demo;
		/* A containing block for the app's fixed layers (mobile drawer and scrim). */
		contain: layout;
	}

	.demo-window :global([data-alpha-demo]) {
		height: 100%;
	}
</style>
