<script lang="ts">
	import { Input, Stack } from '@aipotluck/alpha-ds';
</script>

<Stack gap="3" class="max-w-sm">
	<Input size="sm" placeholder="Small" aria-label="Small" />
	<Input placeholder="Medium" aria-label="Medium" />
	<Input size="lg" placeholder="Large" aria-label="Large" />
	<Input disabled placeholder="Disabled" aria-label="Disabled" />
	<Input aria-invalid="true" value="Invalid value" aria-label="Invalid" />
	<Input
		size="lg"
		appearance="code"
		inputmode="numeric"
		placeholder="000000"
		aria-label="One-time code"
	/>
</Stack>
