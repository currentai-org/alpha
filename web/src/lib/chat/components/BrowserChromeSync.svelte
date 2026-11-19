<!--
  @component
  Tints the browser's address bar and toolbar to the chat window's ground (browserChrome.ts).
  Renders nothing; place it inside the chat's ThemeProvider so it follows the resolved mode and theme.
-->
<script lang="ts">
	import { getThemeContext } from '@aipotluck/alpha-ds';
	import { paintBrowserChrome } from '../browserChrome';

	const theme = getThemeContext();

	$effect(() => {
		const dark = theme?.resolvedMode === 'dark';
		void theme?.theme;
		// Read the ground on the next frame: this effect runs before ThemeProvider's own markup
		// update adds `dark` to the root, so a same-tick read paints the light ground.
		let restore: (() => void) | undefined;
		const frame = requestAnimationFrame(() => {
			const root = document.querySelector<HTMLElement>('.chat-window.ds-root');
			if (!root) return;
			restore = paintBrowserChrome(document, getComputedStyle(root).backgroundColor, dark);
		});
		return () => {
			cancelAnimationFrame(frame);
			restore?.();
		};
	});
</script>
