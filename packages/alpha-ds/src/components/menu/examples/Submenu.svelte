<script lang="ts">
	import { Menu } from '@aipotluck/alpha-ds';
	let model = $state('auto');
</script>

<Menu.Root>
	<Menu.Trigger variant="secondary" casing="sentence"
		>Model: {model === 'auto' ? 'Auto' : model}</Menu.Trigger
	>
	<Menu.Portal>
		<Menu.Positioner>
			<Menu.Popup>
				<Menu.RadioGroup bind:value={model}>
					<Menu.RadioItem value="auto">Auto</Menu.RadioItem>
				</Menu.RadioGroup>
				<Menu.Separator />
				<Menu.SubmenuRoot>
					<Menu.SubmenuTrigger>Advanced</Menu.SubmenuTrigger>
					<Menu.Portal>
						<Menu.Positioner>
							<Menu.Popup>
								<Menu.RadioGroup bind:value={model}>
									<Menu.RadioItem value="Apertus">Apertus</Menu.RadioItem>
									<Menu.RadioItem value="ALIA">ALIA</Menu.RadioItem>
									<Menu.RadioItem value="SEA-LION">SEA-LION</Menu.RadioItem>
								</Menu.RadioGroup>
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.SubmenuRoot>
			</Menu.Popup>
		</Menu.Positioner>
	</Menu.Portal>
</Menu.Root>
