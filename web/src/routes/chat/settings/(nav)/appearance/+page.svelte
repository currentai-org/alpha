<script lang="ts">
	import {
		Button,
		Collapsible,
		Toggle,
		ToggleGroup,
		CUSTOM_THEME_ID,
		customThemeDeclarations,
		defaultCustomTheme,
		getThemeContext,
		themes,
		accentPresets,
		type ColorMode,
		type CustomThemeInput
	} from "@aipotluck/alpha-ds";
	import { CHAT_WINDOW_DEFAULT_MODE } from "$lib/chat/chatTheme";
	import RiArrowRightSLine from "~icons/ri/arrow-right-s-line";
	import RiCheckLine from "~icons/ri/check-line";
	import RiSave3Line from "~icons/ri/save-3-line";
	import { onDestroy, onMount } from "svelte";
	import { untrack } from "svelte";
	import { m } from "$lib/paraglide/messages.js";
	import Switch from "$lib/chat/components/Switch.svelte";
	import { useSettingsStore } from "$lib/chat/stores/settings";
	import { supportsHaptics } from "$lib/chat/utils/haptics";

	// Settings → Appearance: the theme (colour AND shape — corners, elevation, the voice of UI type),
	// the colour mode, and — under Advanced — a builder for your own theme. Everything applies
	// immediately and persists per device through the window's ThemeProvider. Each card previews its
	// theme by scoping `data-ds-theme` (plus inline overrides for the custom one), so what you see is
	// the real token set, not a picture of it.
	const theme = getThemeContext();

	// Haptic feedback, on touch devices only. Held inert until
	// hydrated, so a tap before the handler attaches is not silently dropped (CUR-2009, CUR-1649).
	const settings = useSettingsStore();
	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
	});
	// Theme names are proper nouns; their descriptions are translated here so the design system stays
	// free of interface copy.
	const THEME_DESCRIPTIONS: Record<string, () => string> = {
		alpha: m.settings_themeAlpha,
		paper: m.settings_themePaper,
		soft: m.settings_themeSoft,
		huggingface: m.settings_themeHuggingface,
		mistral: m.settings_themeMistral,
		infomaniak: m.settings_themeInfomaniak,
		cohere: m.settings_themeCohere,
		"swiss-ai": m.settings_themeSwissAi
	};
	const describe = (t: { id: string; description: string }) => THEME_DESCRIPTIONS[t.id]?.() ?? t.description;
	const active = $derived(theme?.theme ?? "alpha");
	const mode = $derived(theme?.resolvedMode ?? "dark");
	const alphaThemes = themes.filter((t) => (t as { group?: string }).group !== "partner");
	const partnerThemes = themes.filter((t) => (t as { group?: string }).group === "partner") as {
		id: string;
		label: string;
		description: string;
		logo?: string;
	}[];

	let advancedOpen = $state(false);
	// Seeded once from the saved custom theme or the active theme; edits stay local until applied.
	let draft = $state<CustomThemeInput>(
		untrack(() => theme?.custom ?? defaultCustomTheme(active === CUSTOM_THEME_ID ? "alpha" : active))
	);
	const draftStyle = $derived(styleOf(customThemeDeclarations(draft)));
	const savedStyle = $derived(theme?.custom ? styleOf(customThemeDeclarations(theme.custom)) : "");

	// While the builder is open, the whole window previews the draft; closing it (or leaving the page)
	// without saving restores the saved theme.
	$effect(() => {
		if (advancedOpen) theme?.previewCustom($state.snapshot(draft));
		else theme?.previewCustom(null);
	});
	onDestroy(() => {
		theme?.preview(null);
		theme?.previewCustom(null);
	});

	function styleOf(decls: Record<string, string>) {
		return Object.entries(decls)
			.map(([k, v]) => `${k}: ${v}`)
			.join("; ");
	}

</script>

{#snippet preview(themeId: string, style?: string)}
	<!-- A miniature of the real app in this theme: sidebar, a question, an answer, the composer. -->
	<div
		data-ds-theme={themeId}
		data-mode={mode}
		{style}
		class="flex h-36 w-full overflow-hidden bg-surface-1 text-fg-1"
		aria-hidden="true"
	>
		<div class="flex w-1/4 flex-col gap-1.5 border-r border-line-1 bg-surface-1 p-2">
			<span class="mb-1 h-1.5 w-2/3 bg-fg-2 rounded-pill"></span>
			<span class="h-3 w-full bg-tint-hover rounded-sharp"></span>
			<span class="h-1.5 w-3/4 bg-line-3 rounded-pill"></span>
			<span class="h-1.5 w-1/2 bg-line-3 rounded-pill"></span>
		</div>
		<div class="flex flex-1 flex-col gap-2 p-2.5">
			<span class="ml-auto w-3/5 bg-surface-3 px-2 py-1.5 rounded-sharp">
				<span class="block h-1.5 w-full bg-fg-3 rounded-pill"></span>
			</span>
			<span class="flex flex-col gap-1">
				<span class="h-1.5 w-11/12 bg-fg-2 rounded-pill"></span>
				<span class="h-1.5 w-4/5 bg-fg-2 rounded-pill"></span>
				<span class="h-1.5 w-2/5 bg-fg-2 rounded-pill"></span>
			</span>
			<span class="mt-auto flex items-center gap-1.5 border border-line-2 bg-surface-2 p-1.5 rounded-field">
				<span class="h-1.5 flex-1 bg-line-2 rounded-pill"></span>
				<span class="size-3.5 bg-accent-1 rounded-pill"></span>
			</span>
		</div>
	</div>
{/snippet}

{#snippet card(id: string, label: string, description: string, previewTheme: string, style?: string, logo?: string)}
	{@const selected = active === id}
	<button
		type="button"
		role="radio"
		aria-checked={selected}
		data-theme-card={id}
		onclick={() => theme?.setTheme(id)}
		onmouseenter={() => !advancedOpen && theme?.preview(id)}
		onmouseleave={() => !advancedOpen && theme?.preview(null)}
		onfocus={() => !advancedOpen && theme?.preview(id)}
		onblur={() => !advancedOpen && theme?.preview(null)}
		class="group relative flex flex-col overflow-hidden border bg-surface-raised text-left transition-control rounded-card focus-visible:outline-2 {selected
			? 'border-transparent ring-2 ring-accent-1'
			: 'border-line-2 hover:border-line-3 hover:shadow-popover'}"
	>
		{@render preview(previewTheme, style)}
		<span class="flex items-start gap-2.5 border-t border-line-1 px-3 py-2.5">
			{#if logo}
				<img src={logo} alt="" class="mt-0.5 size-5 shrink-0 border border-line-1 object-contain rounded-sharp" />
			{/if}
			<span class="flex min-w-0 flex-1 flex-col">
				<span class="type-body font-medium text-fg-1">{label}</span>
				<span class="line-clamp-2 type-caption text-fg-3">{description}</span>
			</span>
		</span>
		{#if selected}
			<span class="absolute top-2 right-2 grid size-6 place-items-center bg-accent-1 text-fg-on-accent shadow-popover rounded-pill">
				<RiCheckLine aria-hidden="true" class="size-4" />
			</span>
		{/if}
	</button>
{/snippet}

{#snippet choice(label: string, value: string, options: [string, string][], onchange: (v: string) => void)}
	<div class="flex items-center justify-between gap-4">
		<span class="type-body text-fg-1">{label}</span>
		<ToggleGroup value={[value]} onValueChange={(v: string[]) => v[0] && onchange(v[0])} aria-label={label}>
			{#each options as [v, l] (v)}<Toggle value={v}>{l}</Toggle>{/each}
		</ToggleGroup>
	</div>
{/snippet}

{#snippet colour(label: string, value: string, onchange: (v: string) => void, swatches?: string[])}
	<div class="flex items-center justify-between gap-4">
		<span class="type-body text-fg-1">{label}</span>
		<span class="flex items-center gap-1.5">
			{#each swatches ?? [] as sw (sw)}
				<button
					type="button"
					aria-label="{label} {sw}"
					aria-pressed={value.toLowerCase() === sw}
					onclick={() => onchange(sw)}
					class="size-6 border border-line-2 bg-swatch rounded-pill aria-pressed:outline-2 aria-pressed:outline-offset-2 aria-pressed:outline-fg-1"
					style:--swatch={sw}
				></button>
			{/each}
			<input
				type="color"
				{value}
				aria-label={m.settings_pickAnyColour({ label })}
				oninput={(e) => onchange(e.currentTarget.value)}
				class="h-7 w-10 cursor-pointer border border-line-2 bg-surface-raised p-0.5"
			/>
		</span>
	</div>
{/snippet}

<div class="flex flex-col gap-8">
	<section class="flex flex-col gap-3" aria-labelledby="theme-heading">
		<div>
			<h2 id="theme-heading" class="type-label text-fg-1">{m.product_theme()}</h2>
			<p class="type-caption text-fg-3">{m.settings_themeHelp()}</p>
		</div>
		<div role="radiogroup" aria-labelledby="theme-heading" class="flex flex-col gap-6">
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each alphaThemes as t (t.id)}
					{@render card(t.id, t.label, describe(t), t.id)}
				{/each}
				{#if theme?.custom}
					{@render card(CUSTOM_THEME_ID, m.product_custom(), m.settings_themeCustom(), theme.custom.base, savedStyle)}
				{/if}
			</div>
			<div class="flex flex-col gap-3">
				<div>
					<h3 class="type-label text-fg-2">{m.settings_partnerThemes()}</h3>
					<p class="type-caption text-fg-3">{m.settings_partnerThemesHelp()}</p>
				</div>
				<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{#each partnerThemes as t (t.id)}
						{@render card(t.id, t.label, describe(t), t.id, undefined, t.logo)}
					{/each}
				</div>
			</div>
		</div>
	</section>

	<section class="flex items-start justify-between gap-4" aria-labelledby="mode-heading">
		<div>
			<h2 id="mode-heading" class="type-label text-fg-1">{m.product_mode()}</h2>
			<p class="type-caption text-fg-3">{m.settings_modeHelp()}</p>
		</div>
		<ToggleGroup
			value={[theme?.mode ?? CHAT_WINDOW_DEFAULT_MODE]}
			onValueChange={(v: string[]) => v[0] && theme?.setMode(v[0] as ColorMode)}
			aria-label={m.product_mode()}
		>
			<Toggle value="light">{m.product_light()}</Toggle>
			<Toggle value="dark">{m.product_dark()}</Toggle>
			<Toggle value="system">{m.product_system()}</Toggle>
		</ToggleGroup>
	</section>

	{#if supportsHaptics()}
		<section class="flex items-start justify-between gap-4" aria-labelledby="haptics-heading">
			<div>
				<h2 id="haptics-heading" class="type-label text-fg-1">{m.product_haptics()}</h2>
				<p class="type-caption text-fg-3">{m.product_hapticsHelp()}</p>
			</div>
			<div inert={!hydrated}>
				<Switch
					name="hapticsEnabled"
					label={m.product_haptics()}
					bind:checked={() => $settings.hapticsEnabled, (v) => settings.update((s) => ({ ...s, hapticsEnabled: v }))}
				/>
			</div>
		</section>
	{/if}

	<div class="border-t border-line-1 pt-4"><Collapsible.Root bind:open={advancedOpen}>
		<Collapsible.Trigger data-advanced-theme>
			<RiArrowRightSLine class={advancedOpen ? "rotate-90" : ""} aria-hidden="true" /> {m.settings_advancedTheme()}
		</Collapsible.Trigger>
		<Collapsible.Panel>
			<div class="mt-4 grid gap-6 md:grid-cols-3" data-theme-builder>
				<div class="flex flex-col gap-4 md:col-span-2">
					{@render colour(m.settings_accent(), draft.accent, (v) => (draft = { ...draft, accent: v }), [...accentPresets])}
					{@render colour(m.settings_darkBackground(), draft.darkBackground, (v) => (draft = { ...draft, darkBackground: v }))}
					{@render colour(m.settings_lightBackground(), draft.lightBackground, (v) => (draft = { ...draft, lightBackground: v }))}
					{@render choice(m.settings_corners(), draft.corners, [["sharp", m.settings_cornersSharp()], ["rounded", m.settings_cornersRounded()], ["round", m.settings_cornersRound()]], (v) => (draft = { ...draft, corners: v as CustomThemeInput["corners"] }))}
					{@render choice(m.settings_depth(), draft.elevation, [["flat", m.settings_depthFlat()], ["soft", m.settings_depthSoft()]], (v) => (draft = { ...draft, elevation: v as CustomThemeInput["elevation"] }))}
					{@render choice(m.settings_labels(), draft.uiType, [["mono", m.settings_labelsMono()], ["sans", m.settings_labelsPlain()]], (v) => (draft = { ...draft, uiType: v as CustomThemeInput["uiType"] }))}
					<p class="type-caption text-fg-3">
						{m.settings_textColoursHelp()}
					</p>
				</div>
				<div class="flex flex-col gap-3">
					{@render preview(draft.base, draftStyle)}
					<p class="type-caption text-fg-3">{m.settings_previewHelp()}</p>
				</div>
				<div class="md:col-span-3">
					<Button
						variant="primary"
						size="lg"
						casing="sentence"
						class="w-full justify-center"
						onclick={() => {
							theme?.setCustom($state.snapshot(draft));
							advancedOpen = false;
						}}
						data-apply-custom-theme
					>
						<RiSave3Line aria-hidden="true" /> {m.settings_saveTheme()}
					</Button>
				</div>
			</div>
		</Collapsible.Panel>
	</Collapsible.Root></div>
</div>
