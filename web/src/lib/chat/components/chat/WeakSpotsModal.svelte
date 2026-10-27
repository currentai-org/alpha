<script lang="ts">
	import { on } from 'svelte/events';
	import Modal from '$lib/chat/components/Modal.svelte';
	import { weakSpotsOpen } from '$lib/chat/stores/weakSpots';
	import { m } from '$lib/paraglide/messages.js';

	// The honest "weak spots" disclosure: the system's KNOWN, systematic weaknesses, stated
	// plainly. The whole product's thesis is the opposite of a tool that hides its limits — so
	// these are always available (a footer link), not a per-answer fabricated claim. Every item
	// is grounded in something real and is true regardless of the specific answer:
	//   • Recency — the persona's own recency rule: a fixed cutoff it CANNOT reliably date, so we
	//     never assert a date here either. Web search mitigates it per turn; without it, care.
	//   • Lookup isn't recall — sources read just now are citable; recall is not. Points at X-ray's
	//     "Looked up" line, which is what each answer actually shows; the "looked it up" / "from
	//     training" words exist only in the data export (exportFormat.ts).
	//   • Language coverage — the launch demo prompts (Swahili / Wolof / Fon) exist to expose this.
	//   • One perspective — training data over-represents some countries/cultures, so the "default"
	//     answer can carry one viewpoint as if neutral. The cultural-skew axis, distinct from the
	//     language-quality axis above.
	//   • Not professional advice — Trust & Safety §1, verbatim domains.
	//   • It can be wrong — Terms §4 ("we do not guarantee accuracy… check, not just trust") +
	//     the single-model reality shown in the provenance badge.
	const close = () => weakSpotsOpen.set(false);
	// The footer sentence is translated whole; the Trust & Safety link stands in for its {link} marker.
	const weakFooter = $derived(m.message_weakFooter({ link: '{link}' }).split(/(\{link\})/).filter(Boolean));

	// The list is taller than a short window, and headless and macOS browsers hide the scrollbar until
	// a scroll, so a cue at the bottom says the text continues until its end is in view (CUR-2744).
	// The popup is the scroll box, and this dialog's body is its direct child.
	let body = $state<HTMLDivElement>();
	let more = $state(false);
	$effect(() => {
		const scroller = body?.parentElement;
		if (!scroller) return;
		const update = () => {
			more = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 4;
		};
		update();
		const off = on(scroller, 'scroll', update, { passive: true });
		const resize = new ResizeObserver(update);
		resize.observe(scroller);
		return () => {
			off();
			resize.disconnect();
		};
	});

	// Functions, not strings, so the copy follows a language switch.
	const SPOTS: { id: string; title: () => string; body: () => string }[] = [
		{ id: 'recency', title: () => m.message_weakRecencyTitle(), body: () => m.message_weakRecencyBody() },
		{ id: 'lookup', title: () => m.message_weakLookupTitle(), body: () => m.message_weakLookupBody() },
		{ id: 'language', title: () => m.message_weakLanguageTitle(), body: () => m.message_weakLanguageBody() },
		{ id: 'perspective', title: () => m.message_weakPerspectiveTitle(), body: () => m.message_weakPerspectiveBody() },
		{ id: 'advice', title: () => m.message_weakAdviceTitle(), body: () => m.message_weakAdviceBody() },
		{ id: 'wrong', title: () => m.message_weakWrongTitle(), body: () => m.message_weakWrongBody() }
	];
</script>

{#if $weakSpotsOpen}
	<Modal width="max-w-md! m-4!" closeButton onclose={close}>
		<div bind:this={body} class="flex w-full flex-col gap-4 bg-[var(--ap-paper)] px-6 py-6">
			<div class="flex flex-col gap-1.5">
				<h2 tabindex="-1" data-autofocus class="font-serif outline-none text-[length:var(--ap-text-5)] text-[var(--ap-ink)]">{m.message_whereWeak()}</h2>
				<p class="text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)]">
					{m.message_weakIntro()}
				</p>
			</div>
			<ul class="flex flex-col gap-3">
				{#each SPOTS as spot (spot.id)}
					<li class="flex flex-col gap-0.5">
						<span class="font-mono text-[length:var(--ap-text-2)] tracking-[0.06em] text-[var(--ap-ink)] uppercase"
							>{spot.title()}</span
						>
						<span class="text-[length:var(--ap-text-2)] leading-relaxed text-[var(--ap-ink-3)]">{spot.body()}</span>
					</li>
				{/each}
			</ul>
			<p class="text-[length:var(--ap-text-1)] text-[var(--ap-ink-3)]/70">
				{#each weakFooter as part, i (i)}{#if part === '{link}'}<a
							class="underline underline-offset-2 hover:text-[var(--ap-ink)]"
							href="/trust-and-safety">{m.message_trustSafetyPage()}</a
						>{:else}{part}{/if}{/each}
			</p>
			{#if more}
				<div
					data-scroll-cue
					aria-hidden="true"
					class="pointer-events-none sticky bottom-0 -mx-6 -mt-16 flex h-12 items-end justify-center bg-linear-to-t from-surface-1 from-40% to-surface-1/0 pb-2 type-caption text-fg-2"
				>
					More below ↓
				</div>
			{/if}
		</div>
	</Modal>
{/if}
