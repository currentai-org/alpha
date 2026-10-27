/**
 * Tailwind colour utility name → `--ds-*` token. `bg-surface-2` reads `--ds-bg-2`, `text-fg-3`
 * reads `--ds-fg-3`, `border-line-surface` reads the contextual `--ds-surface-line`.
 * Consumed by the generator (build.ts) and by the class merger (internal/cn.ts).
 */
export const TAILWIND_COLORS: Record<string, string> = {
	'surface-1': 'bg-1',
	'surface-2': 'bg-2',
	'surface-3': 'bg-3',
	surface: 'surface',
	'surface-raised': 'surface-raised',
	chrome: 'bg-chrome',
	inverse: 'bg-inverse',
	'fg-1': 'fg-1',
	'fg-2': 'fg-2',
	'fg-3': 'fg-3',
	'fg-on-chrome': 'fg-on-chrome',
	'fg-inverse': 'fg-inverse',
	'fg-on-accent': 'fg-on-accent',
	'line-1': 'line-1',
	'line-2': 'line-2',
	'line-3': 'line-3',
	'line-strong': 'line-strong',
	'line-surface': 'surface-line',
	'accent-1': 'accent-1',
	'accent-1-hover': 'accent-1-hover',
	'accent-1-text': 'accent-1-text',
	'accent-2': 'accent-2',
	'accent-2-hover': 'accent-2-hover',
	'accent-2-text': 'accent-2-text',
	positive: 'positive',
	'positive-text': 'positive-text',
	caution: 'caution',
	'caution-text': 'caution-text',
	'tint-subtle': 'tint-subtle',
	'tint-hover': 'tint-hover',
	'tint-active': 'tint-active',
	focus: 'focus',
	overlay: 'overlay',
	grid: 'grid'
};
