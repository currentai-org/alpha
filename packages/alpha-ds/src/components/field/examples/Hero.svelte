<script lang="ts">
	import { Field, Stack } from '@aipotluck/alpha-ds';
	let email = $state('not-an-email');
	const invalid = $derived(!email.includes('@'));
</script>

<Stack gap="6" class="max-w-sm">
	<Field.Root>
		<Field.Label>Display name</Field.Label>
		<Field.Control placeholder="Ada" />
		<Field.Description>Shown on shared conversations.</Field.Description>
	</Field.Root>
	<Field.Root {invalid}>
		<Field.Label>Email</Field.Label>
		<Field.Control bind:value={email} type="email" />
		<Field.Error>Enter a valid email address.</Field.Error>
	</Field.Root>
</Stack>
