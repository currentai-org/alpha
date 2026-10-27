<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { getAlphaLandingContent } from '../../content.svelte';
	import { LexicalRenderer } from '$lib/websiteAlpha';
	import { lexicalParagraphTexts } from '$lib/lexical/to-plain-text';
	const readContent = getAlphaLandingContent();
	const faq = $derived(
		readContent().faq.map((group) => ({
			...group,
			items: group.items.map(({ key, ...item }) => ({ ...item, id: key }))
		}))
	);
	const faqIntro = $derived(readContent().faqIntro);
	const faqTitle = $derived(readContent().faqTitle);
</script>

<section
	id="faq"
	class="scroll-mt-[calc(var(--nav-bar-offset)+1.5rem)] py-24 md:py-32"
	aria-labelledby="alpha-faq-title"
>
	<div class="mx-auto grid w-full max-w-8xl gap-x-16 gap-y-12 px-(--panel-padding) lg:grid-cols-12">
		<div class="lg:col-span-5">
			<div class="lg:sticky lg:top-[calc(var(--nav-bar-offset)+2.5rem)]">
				<p
					class="flex items-center gap-3 font-mono text-[12px] tracking-[0.16em] text-dark-blue/60 uppercase"
				>
					<span class="pat pat-tiles tone-pink size-3.5" style:--pat-cell="7px" aria-hidden="true"
					></span>
					{readContent().faqEyebrow}
				</p>
				<h2
					id="alpha-faq-title"
					class="mt-5 font-noto-serif text-[clamp(2.5rem,5.4vw,3.75rem)] leading-[0.96] font-semibold tracking-[-0.035em]"
				>
					{faqTitle}
				</h2>
				<p
					class="mt-6 max-w-sm font-jakarta text-[clamp(1.0625rem,1.3vw,1.1875rem)] leading-relaxed text-dark-blue/80"
				>
					{faqIntro}
				</p>
			</div>
		</div>

		<div class="flex flex-col gap-12 lg:col-span-7">
			{#each faq as group, groupIndex (group.heading ?? groupIndex)}
				<div>
					{#if group.heading}
						<h3 class="mb-2 font-mono text-[12px] tracking-[0.16em] text-dark-blue/50 uppercase">
							{group.heading}
						</h3>
					{/if}
					{#each group.items as item (item.id)}
						<details
							class="group border-b border-dark-blue/15 details-content:grid details-content:grid-rows-[0fr] details-content:transition-[grid-template-rows,content-visibility] details-content:transition-discrete details-content:duration-300 details-content:ease-out open:details-content:grid-rows-[1fr] motion-reduce:details-content:transition-none"
						>
							<summary
								class="flex cursor-pointer list-none items-center justify-between gap-6 py-5 [&::-webkit-details-marker]:hidden"
							>
								<span
									class="font-jakarta text-[clamp(1.0625rem,1.4vw,1.25rem)] font-semibold tracking-tight transition-colors group-hover:text-dark-blue/70"
								>
									{item.question}
								</span>
								<span
									class="grid size-9 shrink-0 place-items-center bg-pale-grey transition-[background-color,rotate] duration-300 group-open:rotate-45 group-open:bg-(--bold-coral) group-open:text-white motion-reduce:transition-none"
									aria-hidden="true"
								>
									<PlusIcon class="size-4" strokeWidth={2.5} />
								</span>
							</summary>
							<div class="overflow-hidden">
								<div
									class="max-w-2xl pr-14 pb-6 font-jakarta text-[16px] leading-7 text-dark-blue/85"
								>
									{#if LexicalRenderer}
										<LexicalRenderer content={item.answer} class="richtext" />
									{:else}
										<!-- No CMS rich-text renderer in this build: the answer's paragraphs as plain text. -->
										{#each lexicalParagraphTexts(item.answer, 20) as paragraph, i (i)}
											<p>{paragraph}</p>
										{/each}
									{/if}
								</div>
							</div>
						</details>
					{/each}
				</div>
			{/each}
		</div>
	</div>
</section>
