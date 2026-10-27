<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { base } from "$lib/chat/paths";
	import { page } from "$app/state";
	import { Badge } from "@aipotluck/alpha-ds";
	import {
		groupSettingsSections,
		settingsNavInputs,
		settingsExternalLinks,
		settingsReturnTo,
		settingsSections,
	} from "$lib/chat/settingsSections";
	import RiArrowRightSLine from "~icons/ri/arrow-right-s-line";
	import RiArrowLeftLine from "~icons/ri/arrow-left-line";
	import RiArrowRightUpLine from "~icons/ri/arrow-right-up-line";

	// /settings?sections — the section list at phone width; tap into a section, back returns here.
	// Bare /settings redirects to Personalization in its load (+page.ts), and so does a desktop landing here,
	// since the sidebar already lists the sections.
	const sections = $derived(
		settingsSections({
			base,
			path: page.url.pathname,
			...settingsNavInputs(page.data)
		})
	);
</script>

<nav aria-label={m.product_settingsSections()} class="flex flex-col gap-6" data-settings-index>
	{#each groupSettingsSections(sections) as g (g.group)}
		<div class="flex flex-col gap-2">
			<h2 class="px-1 type-label text-fg-3">{g.label}</h2>
			<ul data-surface="2" class="flex flex-col divide-y divide-line-surface border border-line-2 bg-surface-2 rounded-card">
				{#each g.items as section (section.label)}
					<li>
						<a
							href={section.href}
							aria-label={section.ariaLabel}
							class="flex min-h-control-lg items-center gap-3 px-4 type-body text-fg-1 hover:bg-tint-subtle"
						>
							<section.icon aria-hidden="true" class="size-4 shrink-0 text-fg-2" />
							<span class="flex-1">{section.label}</span>
							{#if section.badge}<Badge>{section.badge}</Badge>{/if}
							<RiArrowRightSLine aria-hidden="true" class="size-4 text-fg-3" />
						</a>
					</li>
				{/each}
			</ul>
		</div>
	{/each}
	<ul data-surface="2" class="flex flex-col divide-y divide-line-surface border border-line-2 bg-surface-2 rounded-card">
		{#each settingsExternalLinks() as link (link.href)}
			<li>
				<a
					href={link.href}
					target="_blank"
					rel="noopener"
					aria-label={m.product_opensInNewTab({ label: link.label })}
					data-settings-external
					class="flex min-h-control-lg items-center gap-3 px-4 type-body text-fg-1 hover:bg-tint-subtle"
				>
					<link.icon aria-hidden="true" class="size-4 shrink-0 text-fg-2" />
					<span class="flex-1">{link.label}</span>
					<RiArrowRightUpLine aria-hidden="true" class="size-4 text-fg-3" />
				</a>
			</li>
		{/each}
	</ul>
	<a
		href={$settingsReturnTo ?? `${base}/`}
		class="mt-6 inline-flex items-center gap-2 self-start type-body text-fg-2 hover:text-fg-1"
	>
		<RiArrowLeftLine aria-hidden="true" class="size-4" /> {m.product_backToApp()}
	</a>
</nav>
