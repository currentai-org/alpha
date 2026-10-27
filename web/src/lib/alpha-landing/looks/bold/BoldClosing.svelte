<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import PotluckMark from '$lib/chat/components/PotluckMark.svelte';
	import { isExternalHref } from '$lib/utils/hrefs';
	import { getAlphaLandingContent } from '../../content.svelte';
	const readContent = getAlphaLandingContent();
	const closing = $derived(readContent().closing);
	import BoldBuildField from './BoldBuildField.svelte';

	const [primary, secondary] = $derived(closing.actions);
</script>

<section
	class="relative isolate overflow-hidden bg-dark-blue text-white"
	aria-labelledby="alpha-closing-title"
>
	<BoldBuildField />
	<div
		class="relative z-[1] mx-auto grid w-full max-w-8xl px-(--panel-padding) pt-24 pb-[min(42vh,22rem)] md:pt-32 lg:grid-cols-12 lg:pb-32"
	>
		<div class="lg:col-span-7">
			<p
				class="flex items-center gap-3 font-mono text-[13px] tracking-[0.16em] text-white/80 uppercase"
			>
				<PotluckMark class="size-4 text-(--bold-coral)" />
				{closing.eyebrow}
			</p>
			<h2
				id="alpha-closing-title"
				class="mt-6 font-noto-serif text-[clamp(3rem,6.8vw,6.25rem)] leading-[0.92] font-semibold tracking-[-0.04em] text-balance"
			>
				{closing.title}
			</h2>
			<p
				class="mt-8 max-w-xl font-jakarta text-[clamp(1.125rem,1.5vw,1.3125rem)] leading-relaxed text-white/90"
			>
				{closing.body}
			</p>
			<div class="mt-10 flex flex-wrap items-center gap-x-7 gap-y-4">
				<!-- eslint-disable svelte/no-navigation-without-resolve -- /chat, /contribute and an external partner are plain links -->
				<a
					href={primary.href}
					class="group inline-flex h-14 items-stretch bg-(--bold-coral) font-jakarta text-lg font-bold text-white transition-transform hover:-translate-y-0.5"
				>
					<span class="flex items-center px-6">{primary.label}</span>
					<span
						class="flex w-14 items-center justify-center bg-dark-blue/10 transition-colors group-hover:bg-dark-blue group-hover:text-(--bold-coral)"
					>
						<ArrowRightIcon class="size-5" strokeWidth={2.5} aria-hidden="true" />
					</span>
				</a>
				<a
					href={secondary.href}
					target={isExternalHref(secondary.href) ? '_blank' : undefined}
					rel={isExternalHref(secondary.href) ? 'noopener noreferrer' : undefined}
					class="inline-flex h-14 items-center gap-2 border-2 border-white bg-dark-blue px-5 font-jakarta text-lg font-semibold text-white transition-colors hover:bg-white hover:text-dark-blue"
				>
					{secondary.label}
					<ArrowUpRightIcon class="size-4" aria-hidden="true" />
				</a>
				<a
					href={closing.more.href}
					class="group inline-flex items-center gap-2 font-jakarta text-lg font-semibold text-white"
				>
					<span
						class="underline decoration-white/40 decoration-2 underline-offset-[6px] group-hover:decoration-(--bold-coral)"
						>{closing.more.label}</span
					>
					<ArrowRightIcon
						class="size-4 transition-transform group-hover:translate-x-1"
						aria-hidden="true"
					/>
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			</div>
		</div>
	</div>
</section>
