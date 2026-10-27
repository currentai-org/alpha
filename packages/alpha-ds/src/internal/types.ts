import type { Snippet } from 'svelte';
import type { ClassValue } from 'clsx';

/**
 * Props every design-system part accepts, mirroring Base UI's common props
 * (`className` → `class`, `render` → `child` snippet).
 */
export interface PartProps {
	/** Extra classes, merged last so they win conflicts. Layout only — see lint rule `no-restyle`. */
	class?: ClassValue;
	/** Content. */
	children?: Snippet;
}

/** Surface tiers a part can establish (see `[data-surface]` in tokens.css). */
export type SurfaceLevel = '1' | '2' | '3' | 'chrome';
