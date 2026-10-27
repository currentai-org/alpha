<script lang="ts">
	import { Composer, ComposerAccessory } from '@aipotluck/alpha-ds';
	import RiShieldCheckLine from '~icons/ri/shield-check-line';
	import RiSparkling2Line from '~icons/ri/sparkling-2-line';
	let value = $state('');
</script>

<div class="w-full max-w-thread">
	<ComposerAccessory.Root>
		<ComposerAccessory.Panel value="route" label="How Alpha chose a model">
			<p class="type-body text-fg-1">
				You’re writing in Catalan, so ALIA answers — built for Catalan and Spanish.
			</p>
		</ComposerAccessory.Panel>
		<ComposerAccessory.Panel value="privacy" label="Where your message goes">
			<p class="type-body text-fg-1">
				Answered in Switzerland by Infomaniak. Stored by Current AI.
			</p>
		</ComposerAccessory.Panel>
		<Composer.Root bind:value>
			<Composer.Input />
			<Composer.Toolbar><Composer.Send /></Composer.Toolbar>
		</Composer.Root>
		<ComposerAccessory.Row>
			<ComposerAccessory.Pill value="route" icon={RiSparkling2Line}
				>Auto · Catalan</ComposerAccessory.Pill
			>
			<ComposerAccessory.Pill value="privacy" icon={RiShieldCheckLine}
				>Private</ComposerAccessory.Pill
			>
		</ComposerAccessory.Row>
	</ComposerAccessory.Root>
</div>
