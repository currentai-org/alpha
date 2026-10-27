<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { tick } from "svelte";
	import { base } from "$lib/chat/paths";
	import { goto, preloadData } from "$app/navigation";
	import { page } from "$app/state";
	import { useSettingsStore } from "$lib/chat/stores/settings";
	import { Button, Input, PageHeader, Popover } from "@aipotluck/alpha-ds";
	import IconOmni from "$lib/chat/components/icons/IconOmni.svelte";
	import RiFileTextLine from "~icons/ri/file-text-line";
	import RiImageLine from "~icons/ri/image-line";
	import RiArrowDownSLine from "~icons/ri/arrow-down-s-line";
	import RiArrowLeftLine from "~icons/ri/arrow-left-line";
	import { trackEvent } from "$lib/analytics";
	import {
		SETTINGS_GROUP_LABEL,
		settingsNavInputs,
		settingsReturnTo,
		settingsSections,
		settingsSubpage,
		settingsWidePage,
	} from "$lib/chat/settingsSections";
	import { pickerDisplayName } from "$lib/chat/identity";

	import type { LayoutData } from "../$types";

	interface Props {
		data: LayoutData;
		children?: import("svelte").Snippet;
	}

	let { data, children }: Props = $props();

	// Warm the "Back to app" destination's data as soon as we know it, so leaving settings
	// has nothing left to fetch. Best-effort: a failed preload only means a slower return. (CUR-1132)
	$effect(() => {
		if ($settingsReturnTo) preloadData($settingsReturnTo).catch(() => {});
	});

	// Bare /settings redirects to Personalization in its load (+page.ts, CUR-2115), so it never paints an empty
	// body. On mobile there is no sidebar in view, so /settings?sections IS the section list
	// (+page.svelte) and each section opens as its own page with a back button — the iOS/Claude mobile
	// settings shape. A desktop that lands on the list anyway goes to Personalization: its sidebar lists them.
	const isIndex = $derived(page.url.pathname.replace(/\/$/, "") === `${base}/settings`);
	$effect(() => {
		if (isIndex && window.matchMedia("(min-width: 768px)").matches) {
			goto(`${base}/settings/personalization`, { replaceState: true });
		}
	});

	const settings = useSettingsStore();

	// Local filter for the model dropdown (hyphen/space insensitive) — unchanged from the old
	// always-visible list, just relocated into the popover below.
	let modelFilter = $state("");
	const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ");
	let queryTokens = $derived(normalize(modelFilter).trim().split(/\s+/).filter(Boolean));
	let filteredModels = $derived(
		data.models
			.filter((el) => !el.unlisted)
			.filter((el) => {
				const haystack = normalize(`${el.id} ${el.name ?? ""} ${el.displayName ?? ""}`);
				return queryTokens.every((q) => haystack.includes(q));
			})
	);

	// Same signal as the /models gallery page — a search with no results is a gap-map
	// candidate. `surface` distinguishes the two pickers in analytics without splitting the event
	// name (same underlying question either way: "what did someone look for and not find"). (CUR-422)
	let noResultsTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const query = modelFilter.trim();
		const empty = filteredModels.length === 0;
		clearTimeout(noResultsTimer);
		if (!query || !empty) return;
		noResultsTimer = setTimeout(() => {
			trackEvent("model_search_no_results", { query, surface: "settings_picker" });
		}, 800);
		return () => clearTimeout(noResultsTimer);
	});

	let currentModelId = $derived(page.params.model as string | undefined);
	let currentModel = $derived(data.models.find((m) => m.id === currentModelId));

	let modelPickerOpen = $state(false);
	let modelListContainer: HTMLDivElement | undefined = $state();
	let modelSearchInput: HTMLInputElement | undefined = $state();

	// Opening re-seeds the filter and scrolls the current model into view, mirroring what the old
	// always-visible list did on mount/navigation — just triggered by the popover opening instead.
	$effect(() => {
		if (!modelPickerOpen) return;
		modelFilter = "";
		tick().then(() => {
			const container = modelListContainer;
			const id = currentModelId;
			if (!container || !id) return;
			const buttons = container.querySelectorAll<HTMLButtonElement>("button[data-model-id]");
			for (const btn of buttons) {
				if (btn.dataset.modelId === id) {
					btn.scrollIntoView({ block: "nearest", inline: "nearest" });
					break;
				}
			}
		});
	});

	function pickModel(id: string) {
		modelPickerOpen = false;
		goto(`${base}/settings/${id}`);
	}

	// The section list lives in the sidebar while settings is open (NavMenu); on mobile, where the
	// sidebar is a drawer, the same list shows as a strip above the page.
	const sections = $derived(
		settingsSections({
			base,
			path: page.url.pathname,
			...settingsNavInputs(page.data)
		})
	);
	const currentSection = $derived(sections.find((s) => s.current));
	const groupLabel = $derived(currentSection?.group === "potluck" ? SETTINGS_GROUP_LABEL.potluck : m.product_settings());
	// A step a section's page is on (the language being evaluated) replaces its title, one level down.
	const subpage = $derived(currentSection && !currentModel ? $settingsSubpage : undefined);
	const headerTitle = $derived(
		currentModel ? pickerDisplayName(currentModel) : (subpage?.label ?? currentSection?.label ?? m.product_settings())
	);
	// Every settings page gets its tab title here, once: left unset, the tab kept the title of the
	// conversation the visitor came from.
	const tabTitle = $derived(
		headerTitle === m.product_settings() ? `${headerTitle} — Alpha` : `${headerTitle} — ${m.product_settings()} — Alpha`
	);
	// A page one level down (a single model under Model settings, a language under Evaluate language)
	// shows its trail, each step a link back; top-level sections keep the plain group eyebrow. On
	// phones the back button climbs one level the same way. The active model's own page is a top-level
	// entry ("Model: <name>"), so it has no parent to climb to.
	const parent = $derived(
		!currentSection
			? undefined
			: subpage
				? { label: currentSection.label, href: subpage.parentHref ?? currentSection.href }
				: currentModel && currentSection.href !== page.url.pathname
					? { label: currentSection.label, href: currentSection.href }
					: undefined
	);
	const breadcrumbs = $derived(parent ? [{ label: groupLabel }, parent] : undefined);
	const mobileBack = $derived(parent ?? { href: `${base}/settings?sections`, label: m.product_settings() });
</script>

<svelte:head>
	<title>{tabTitle}</title>
</svelte:head>

<div class="flex h-full min-h-0 w-full flex-col">
	{#if !isIndex}
		<!-- Mobile: each section is its own page; back returns to the section list, or to the parent
		     page from one level down. -->
		<div class="flex h-header shrink-0 items-center gap-1 border-b border-line-1 px-2 md:hidden">
			<Button href={mobileBack.href} variant="ghost" size="md" casing="sentence" data-settings-mobile-back>
				<RiArrowLeftLine aria-hidden="true" />
				{mobileBack.label}
			</Button>
		</div>
	{/if}

		<div class="scrollbar-custom scroll-fade-y min-h-0 flex-1 overflow-x-clip overflow-y-auto" data-settings-scroll>
			<div class="mx-auto flex w-full flex-col gap-6 px-4 py-6 md:px-8 {$settingsWidePage ? 'max-w-6xl' : 'max-w-3xl'}">
				<PageHeader eyebrow={isIndex ? undefined : groupLabel} {breadcrumbs} title={headerTitle}>
					{#snippet actions()}
						{#if currentModelId}
							<!-- Models section: switch which model you're configuring. -->
							<Popover.Root bind:open={modelPickerOpen}>
								<Popover.Trigger variant="secondary" size="sm" casing="sentence" aria-label={m.settings_chooseModel()}>
									{m.settings_switchModel()}
									<RiArrowDownSLine aria-hidden="true" />
								</Popover.Trigger>
								<Popover.Portal>
									<Popover.Positioner side="bottom" align="end">
										<Popover.Popup
											size="md"
											padded={false}
											onOpenAutoFocus={(e) => {
												e.preventDefault();
												modelSearchInput?.focus();
											}}
										>
											<div class="border-b border-line-surface px-3">
												<Input
													bind:ref={modelSearchInput}
													bind:value={modelFilter}
													type="search"
													placeholder={m.settings_searchByName()}
													aria-label={m.settings_searchModels()}
													appearance="bare"
												/>
											</div>
											<div bind:this={modelListContainer} class="scrollbar-custom flex max-h-80 flex-col overflow-y-auto p-1">
												{#if modelFilter.trim() && filteredModels.length === 0}
													<p class="p-2 type-caption text-fg-2">
														{m.settings_noModelsNamed({ query: modelFilter.trim() })} <a href="/map" class="underline">{m.settings_exploreGapMap()}</a>
													</p>
												{/if}
												{#each filteredModels as model (model.id)}
													<button
														type="button"
														onclick={() => pickModel(model.id)}
														class="flex min-h-control-sm w-full items-center gap-2 px-2 py-1 text-left type-body text-fg-2 hover:bg-tint-hover hover:text-fg-1 aria-[current=true]:bg-tint-hover aria-[current=true]:text-fg-1"
														aria-current={model.id === currentModelId ? "true" : undefined}
														data-model-id={model.id}
														aria-label={m.settings_configureModel({ model: pickerDisplayName(model) })}
													>
														{#if model.isRouter}
															<IconOmni classNames="size-3.5 flex-none" />
														{:else if model.logoUrl}
															<img src={model.logoUrl} alt="" loading="lazy" decoding="async" class="size-3.5 flex-none border border-line-2" />
														{:else}
															<!-- An alignment spacer with no border: a bordered empty square down a list of names reads as
														     an unchecked checkbox (CUR-1772). -->
															<span class="size-3.5 flex-none"></span>
														{/if}
														<span class="min-w-0 flex-1 truncate">{pickerDisplayName(model)}</span>
														{#if $settings.multimodalOverrides?.[model.id] ?? model.multimodal}
															<RiImageLine class="size-3 flex-none text-fg-3" aria-label={m.settings_multimodal()} role="img" />
														{/if}
														{#if $settings.customPrompts?.[model.id]}
															<RiFileTextLine class="size-3 flex-none text-fg-3" aria-label={m.settings_hasCustomPrompt()} role="img" />
														{/if}
														{#if model.id === $settings.activeModel}
															<span class="flex-none type-label text-fg-3">Active</span>
														{/if}
													</button>
												{/each}
											</div>
										</Popover.Popup>
									</Popover.Positioner>
								</Popover.Portal>
							</Popover.Root>
						{/if}
					{/snippet}
				</PageHeader>
				{@render children?.()}
			</div>
		</div>
</div>
