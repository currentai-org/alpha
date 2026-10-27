<script lang="ts">
	import { Button, Stack, Inline } from '@aipotluck/alpha-ds';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
	import RiArrowUpLine from '~icons/ri/arrow-up-line';
</script>

<Stack gap="4">
	<Inline gap="3">
		<Button variant="primary">Primary</Button>
		<Button variant="secondary">Secondary</Button>
		<Button variant="ghost">Ghost</Button>
		<Button variant="link">Link</Button>
	</Inline>
	<Inline gap="3">
		<!-- Destructive: looks like secondary; only the icon takes Accent 2 -->
		<Button variant="destructive"><RiDeleteBinFill aria-hidden="true" /> Forget everything</Button>
		<!-- Accent fill: icon-button scale only (send) -->
		<Button variant="accent" size="icon" shape="pill" aria-label="Send"
			><RiArrowUpLine aria-hidden="true" /></Button
		>
	</Inline>
</Stack>
