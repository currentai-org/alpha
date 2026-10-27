<script lang="ts">
	import { Button, Sheet } from '@aipotluck/alpha-ds';
	let open = $state(false);
</script>

<Button onclick={() => (open = true)} casing="sentence">Open sheet</Button>
<Sheet.Root bind:open>
	<Sheet.Portal>
		<Sheet.Backdrop />
		<Sheet.Popup>
			<Sheet.Header title="Where your message goes" />
			<Sheet.Body>
				<p class="type-body text-fg-2">
					Answered in Switzerland by Infomaniak. Stored by Current AI.
				</p>
			</Sheet.Body>
		</Sheet.Popup>
	</Sheet.Portal>
</Sheet.Root>
