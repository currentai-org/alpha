<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { BentoTile, themes } from '@aipotluck/alpha-ds';
	import RiPaletteLine from '~icons/ri/palette-line';
	import RiSunLine from '~icons/ri/sun-line';
	import RiMoonLine from '~icons/ri/moon-line';
	import RiArrowUpLine from '~icons/ri/arrow-up-line';

	/**
	 * Theme: click a swatch and the little Alpha window re-themes live, using the same theme tokens
	 * the app ships (`data-ds-theme` + `data-mode`) — colour, corners and type all change.
	 */
	let theme = $state<string>('alpha');
	let mode = $state<'light' | 'dark'>('light');
</script>

<BentoTile
	icon={RiPaletteLine}
	title={m.welcome_lookTitle()}
	body={m.welcome_lookBody()}
>
	<div class="flex w-full max-w-sm flex-col gap-3">
		<div
			data-ds-theme={theme}
			data-mode={mode}
			class="flex flex-col gap-2.5 rounded-card bg-surface-1 p-3 text-fg-1 shadow-popover transition-control"
			aria-label={m.welcome_themePreview()}
		>
			<div class="flex items-center justify-between type-caption text-fg-3">
				<span class="font-medium text-fg-1">Alpha</span><span>{m.product_today()}</span>
			</div>
			<span class="self-end rounded-sharp bg-surface-3 px-3 py-1.5 type-caption text-fg-1"
				>{m.welcome_picnicQuestion()}</span
			>
			<p class="type-caption text-fg-2">
				{m.welcome_picnicAnswer()}
			</p>
			<div
				class="flex items-center gap-2 rounded-field border border-line-2 bg-surface-2 py-1.5 pr-1.5 pl-3"
			>
				<span class="flex-1 type-caption text-fg-3">{m.welcome_askAnything()}</span>
				<span class="grid size-6 place-items-center rounded-pill bg-accent-1 text-fg-on-accent"
					><RiArrowUpLine aria-hidden="true" class="size-3.5" /></span
				>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<div class="flex flex-1 flex-wrap gap-1.5" role="radiogroup" aria-label={m.welcome_theme()}>
				{#each themes as t (t.id)}
					<button
						type="button"
						role="radio"
						aria-checked={theme === t.id}
						title={t.label}
						aria-label={t.label}
						data-ds-theme={t.id}
						data-mode={mode}
						class="grid size-7 place-items-center rounded-pill border bg-surface-1 transition-control hover:scale-110 {theme ===
						t.id
							? 'border-fg-1 ring-2 ring-accent-1'
							: 'border-line-2'}"
						onclick={() => (theme = t.id)}
					>
						<span class="size-3.5 rounded-pill bg-accent-1"></span>
					</button>
				{/each}
			</div>
			<button
				type="button"
				class="grid size-7 place-items-center rounded-pill border border-line-2 bg-surface-1 text-fg-2 hover:text-fg-1"
				aria-label={mode === 'light' ? m.welcome_previewDark() : m.welcome_previewLight()}
				onclick={() => (mode = mode === 'light' ? 'dark' : 'light')}
			>
				{#if mode === 'light'}<RiMoonLine aria-hidden="true" class="size-3.5" />{:else}<RiSunLine
						aria-hidden="true"
						class="size-3.5"
					/>{/if}
			</button>
		</div>
		<p class="type-caption text-fg-3">
			{mode === 'light'
				? m.welcome_themeLight({ theme: themes.find((t) => t.id === theme)?.label ?? '' })
				: m.welcome_themeDark({ theme: themes.find((t) => t.id === theme)?.label ?? '' })}
		</p>
	</div>
</BentoTile>
