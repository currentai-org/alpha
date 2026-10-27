import type { Component } from 'svelte';
import Overview from './Overview.svelte';
import Colors from './Colors.svelte';
import Surfaces from './Surfaces.svelte';
import Typography from './Typography.svelte';
import Spacing from './Spacing.svelte';
import Shape from './Shape.svelte';
import Motion from './Motion.svelte';
import Utilities from './Utilities.svelte';
import Icons from './Icons.svelte';
import Theming from './Theming.svelte';
import Linting from './Linting.svelte';
import Changelog from './Changelog.svelte';

/** Foundation slug → page. Slugs match FOUNDATIONS in registry.ts (registry.spec.ts checks). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pages take a `snippets` prop of varying shape
export const FOUNDATION_PAGES: Record<string, Component<any>> = {
	overview: Overview,
	colors: Colors,
	surfaces: Surfaces,
	typography: Typography,
	spacing: Spacing,
	shape: Shape,
	motion: Motion,
	utilities: Utilities,
	icons: Icons,
	theming: Theming,
	changelog: Changelog,
	linting: Linting
};
