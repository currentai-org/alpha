<script lang="ts">
	import { Composer } from '@aipotluck/alpha-ds';
	let busy = $state(true);
</script>

<div class="max-w-thread">
	<Composer.Root value="Compare open speech models" {busy} onstop={() => (busy = false)}>
		<Composer.Input />
		<Composer.Toolbar><Composer.Tools /><Composer.Send /></Composer.Toolbar>
	</Composer.Root>
</div>
