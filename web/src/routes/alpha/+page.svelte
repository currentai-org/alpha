<script lang="ts">
	import {
		alphaLandingSchema,
		defaultAlphaLandingContent,
		type AlphaLandingContent
	} from '$lib/alpha-landing/content';
	import { setAlphaLandingContent } from '$lib/alpha-landing/content.svelte';
	import { chatLinkHref, HandoverLook, LivePreviewListener } from '$lib/websiteAlpha';
	import { localizedHref } from '$lib/i18n/routing';
	import { normalizeLocale } from '$lib/i18n/locales';
	import BoldLook from '$lib/alpha-landing/looks/bold/BoldLook.svelte';
	import ClassicLook from '$lib/alpha-landing/looks/classic/ClassicLook.svelte';
	import PageOptions from '$lib/alpha-landing/PageOptions.svelte';
	import { DEFAULT_LOOK, type LookId } from '$lib/alpha-landing/looks/looks';
	import Seo from '$lib/components/seo/seo.svelte';
	import { resolvePageTitle } from '$lib/constants/site';

	let {
		data
	}: {
		data?: {
			look?: LookId;
			alphaLanding?: AlphaLandingContent;
			isPreview?: boolean;
			locale?: string;
		};
	} = $props();
	let content = $derived(data?.alphaLanding ?? defaultAlphaLandingContent);
	const displayContent = $derived({
		...content,
		hero: {
			...content.hero,
			ctaHref: chatLinkHref(localizedHref(content.hero.ctaHref, normalizeLocale(data?.locale)))
		},
		closing: {
			...content.closing,
			actions: content.closing.actions.map((action) => ({
				...action,
				href: chatLinkHref(localizedHref(action.href, normalizeLocale(data?.locale)))
			})),
			more: {
				...content.closing.more,
				href: chatLinkHref(localizedHref(content.closing.more.href, normalizeLocale(data?.locale)))
			}
		}
	});
	setAlphaLandingContent(() => displayContent);

	const look = $derived(data?.look ?? DEFAULT_LOOK);
</script>

<Seo
	title={resolvePageTitle({ title: content.pageTitle })}
	description={content.pageDescription}
	canonicalPath="/alpha"
/>

{#if data?.isPreview && LivePreviewListener}
	<LivePreviewListener
		data={content}
		onChange={(next: unknown) => {
			const parsed = alphaLandingSchema.safeParse(next);
			if (parsed.success) content = parsed.data;
		}}
	/>
{/if}

{#if look === 'classic'}
	<ClassicLook />
{:else if look === 'handover' && HandoverLook}
	<HandoverLook />
{:else}
	<BoldLook />
{/if}

<PageOptions {look} />
