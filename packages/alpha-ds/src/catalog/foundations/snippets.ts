/**
 * Code shown on foundation pages, keyed by page slug then snippet key. Kept as data so the server
 * load can highlight it (highlight.server.ts) and the page can render it.
 */
import type { CodeLang } from '../highlight.server.ts';

export type Snippet = { code: string; lang: CodeLang; label?: string };

export const FOUNDATION_SNIPPETS: Record<string, Record<string, Snippet>> = {
	overview: {
		quickstart: {
			lang: 'svelte',
			label: 'Quick start',
			code: `<script lang="ts">
  import { ThemeProvider, AppShell, Button, Composer } from '@aipotluck/alpha-ds';
</script>

<ThemeProvider mode="dark" persist="alpha:mode">
  <Button variant="primary">Open Alpha</Button>
</ThemeProvider>`
		},
		tree: {
			lang: 'bash',
			label: 'packages/alpha-ds/src',
			code: `tokens/        scales.ts · themes.ts · color/ (OKLCH engine) · build.ts
               generated/ tokens.css · tailwind.css · tokens.json   ← pnpm ds:tokens
theme/         ThemeProvider · mode (light | dark | system) · portal host
internal/      cn/tv (token-aware merge) · positioner · field context · popup skin
components/    <name>/  Parts.svelte · <name>.recipe.ts · index.ts · <name>.docs.ts · examples/
primitives/    Surface · Stack · Inline · Grid · Center · Frame · VisuallyHidden
patterns/      AppShell · Sidebar · ThreadHeader · Composer · Message · EmptyState · PageHeader
catalog/       registry (docs by convention) · UI for /designsystem
lint/          eslint plugin: alpha-ds/*`
		}
	},
	colors: {
		usage: {
			lang: 'svelte',
			label: 'Using colour tokens',
			code: `<!-- Tailwind utilities (preferred) -->
<div class="bg-surface-2 text-fg-2 border border-line-2">…</div>

<!-- Raw CSS -->
<style>
  .thing { color: var(--ds-fg-3); border-color: var(--ds-line-1); }
</style>`
		}
	},
	surfaces: {
		usage: {
			lang: 'svelte',
			label: 'Surface context',
			code: `<Surface level="2" border="auto" padding="md">
  <!-- Button rests on bg-3 here, bg-2 on the page, bg-2 inside a level-3 panel -->
  <Button>Secondary</Button>
</Surface>`
		}
	},
	typography: {
		usage: {
			lang: 'svelte',
			label: 'Type roles',
			code: `<p class="type-label text-fg-3">Open, public, non profit</p>
<h2 class="type-heading">What do you want to know?</h2>
<p class="type-body text-fg-2">Answers name the model that served them.</p>`
		}
	},
	theming: {
		provider: {
			lang: 'svelte',
			label: 'Mode and theme',
			code: `<ThemeProvider theme="alpha" mode="system" persist="alpha:mode">
  …
</ThemeProvider>

<!-- A subtree can flip mode on its own (the footprint hover card): -->
<div data-mode="light">…</div>`
		},
		regenerate: {
			lang: 'bash',
			label: 'After editing seeds',
			code: 'pnpm ds:tokens        # regenerate\npnpm ds:tokens --check # CI drift check'
		}
	},
	linting: {
		run: { lang: 'bash', label: 'Run', code: 'pnpm lint:design' }
	},
	changelog: {
		record: {
			lang: 'bash',
			label: 'After changing the design system',
			code: `pnpm ds:change "Composer.Chip for active tools"   # writes or updates this branch's entry
pnpm ds:version                                     # version, latest entries, anything unrecorded`
		},
		entry: {
			lang: 'markdown',
			label: 'changelog/2026-09-28-composer-chip.md',
			code: `---
bump: minor
summary: Composer.Chip for active tools
---

A removable chip in the composer toolbar for a tool that is switched on.

<!-- surface: written by \`pnpm ds:change\` — rerun it rather than editing by hand -->

\`\`\`surface
+ part Composer.Chip
+ prop Composer.Chip.dismissLabel
+ prop Composer.Chip.ondismiss
\`\`\``
		}
	}
};
