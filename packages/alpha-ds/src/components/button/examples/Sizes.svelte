<script lang="ts">
	import { Button, Inline, Stack } from '@aipotluck/alpha-ds';
	import RiAddLine from '~icons/ri/add-line';
	import RiSettings3Line from '~icons/ri/settings-3-line';
</script>

<Stack gap="3">
	<Inline gap="2">
		<Button size="xs">XS</Button>
		<Button size="sm">Small</Button>
		<Button size="md">Medium</Button>
		<Button size="lg">Large</Button>
	</Inline>
	<Inline gap="2">
		<Button size="md"><RiAddLine /> New chat</Button>
		<Button variant="ghost" size="icon" aria-label="Settings"><RiSettings3Line /></Button>
		<Button size="icon-sm" aria-label="Add"><RiAddLine /></Button>
		<Button disabled>Disabled</Button>
	</Inline>
</Stack>
