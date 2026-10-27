<!--
  @component
  The /alpha page's options, bottom right: the page language for everyone, plus the visual "look"
  on dev builds (badged Dev). Choosing a language moves to that language's URL and remembers it for
  the product; choosing a look writes `?look=<id>`, so both survive a reload and can be shared.
-->
<script lang="ts">
	import { dev } from '$app/environment';
	import { goto } from '$app/navigation';
	import { Menu } from '@aipotluck/alpha-ds';
	import { setInterfaceLocale } from '$lib/i18n/client.svelte';
	import { localeName, locales, normalizeLocale, type Locale } from '$lib/i18n/locales';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import RiGlobalLine from '~icons/ri/global-line';
	import { LOOKS, LOOK_PARAM, type LookId } from './looks/looks';

	let { look }: { look: LookId } = $props();

	const current = $derived(normalizeLocale(getLocale()));

	function chooseLook(id: string) {
		const url = new URL(location.href);
		url.searchParams.set(LOOK_PARAM, id);
		// A query-only change on this page; reroute owns the localized path.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(url, { noScroll: true, replaceState: true, keepFocus: true });
	}
</script>

<div class="fixed right-4 bottom-4 z-50">
	<Menu.Root>
		<Menu.Trigger
			variant="secondary"
			aria-label={m.site_languageCurrent({ language: localeName(current) })}
			data-page-options
		>
			<RiGlobalLine aria-hidden="true" />
			{localeName(current)}
		</Menu.Trigger>
		<Menu.Portal>
			<Menu.Positioner side="top">
				<Menu.Popup class="w-52">
					<Menu.Group>
						<Menu.GroupLabel>{m.product_language()}</Menu.GroupLabel>
						<Menu.RadioGroup
							value={current}
							onValueChange={(value) => void setInterfaceLocale(value as Locale)}
						>
							{#each locales as locale (locale)}
								<Menu.RadioItem value={locale} lang={locale} data-page-locale={locale}>
									{localeName(locale)}
								</Menu.RadioItem>
							{/each}
						</Menu.RadioGroup>
					</Menu.Group>
					{#if dev}
						<Menu.Separator />
						<Menu.Group>
							<Menu.GroupLabel>Look (Dev)</Menu.GroupLabel>
							<Menu.RadioGroup value={look} onValueChange={chooseLook}>
								{#each LOOKS as option (option.id)}
									<Menu.RadioItem value={option.id} title={option.hint} data-page-look={option.id}>
										{option.label}
									</Menu.RadioItem>
								{/each}
							</Menu.RadioGroup>
						</Menu.Group>
					{/if}
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	</Menu.Root>
</div>
