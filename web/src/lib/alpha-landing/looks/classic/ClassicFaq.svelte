<script lang="ts">
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
</script>

<section
	id="faq"
	class="scroll-mt-[calc(var(--nav-bar-offset)+1.5rem)] border-t border-grid-line py-14 md:py-20"
	aria-labelledby="alpha-faq-title"
>
	<div class="grid gap-10 md:grid-cols-12 md:gap-12">
		<div class="md:col-span-4">
			<h2
				id="alpha-faq-title"
				class="font-noto-serif text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.15] font-semibold tracking-tight text-dark-blue"
			>
				{readContent().faqTitle}
			</h2>
			<p class="mt-4 font-jakarta text-[16px] leading-7 text-dark-blue/80">{faqIntro}</p>
		</div>

		<div class="md:col-span-8">
			{#each faq as group, groupIndex (group.heading ?? groupIndex)}
				{#if group.heading}
					<h3
						class="mb-2 font-jakarta text-[12px] font-semibold tracking-[0.16em] text-dark-blue/45 uppercase {groupIndex >
						0
							? 'mt-10'
							: ''}"
					>
						{group.heading}
					</h3>
				{/if}
				{#each group.items as item (item.id)}
					<details class="group border-b border-grid-line">
						<summary
							class="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-jakarta text-[16px] font-semibold text-dark-blue marker:content-none"
						>
							{item.question}
							<span
								class="font-mono text-[18px] leading-none text-dark-blue/40 group-open:hidden"
								aria-hidden="true">+</span
							>
							<span
								class="hidden font-mono text-[18px] leading-none text-dark-blue/40 group-open:inline"
								aria-hidden="true">–</span
							>
						</summary>
						<div class="pb-5 font-jakarta text-[15px] leading-7 text-dark-blue/80">
							{#if LexicalRenderer}
								<LexicalRenderer content={item.answer} class="richtext" />
							{:else}
								<!-- No CMS rich-text renderer in this build: the answer's paragraphs as plain text. -->
								{#each lexicalParagraphTexts(item.answer, 20) as paragraph, i (i)}
									<p>{paragraph}</p>
								{/each}
							{/if}
						</div>
					</details>
				{/each}
			{/each}
		</div>
	</div>
</section>
