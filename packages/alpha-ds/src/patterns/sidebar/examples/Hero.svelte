<script lang="ts">
	import { AppShell, Menu, Sidebar } from '@aipotluck/alpha-ds';
	import RiChatNewLine from '~icons/ri/chat-new-line';
	import RiMoreLine from '~icons/ri/more-line';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
	let current = $state('EU AI Act catalog gaps');
</script>

<div class="h-80 w-sidebar overflow-hidden border border-line-2">
	<AppShell.Root>
		<AppShell.Sidebar class="relative! translate-x-0!">
			<Sidebar.Actions class="pt-2">
				<Sidebar.Item icon={RiChatNewLine} emphasis label="New chat">New chat</Sidebar.Item>
			</Sidebar.Actions>
			<Sidebar.Content>
				<Sidebar.Section label="Today">
					{#each ['Open speech projects', 'EU AI Act catalog gaps'] as title (title)}
						<Sidebar.Item
							label={title}
							current={current === title}
							onclick={() => (current = title)}
						>
							{title}
							{#snippet trailing()}
								<Menu.Root>
									<Menu.Trigger size="icon-xs" aria-label="Options for {title}"
										><RiMoreLine /></Menu.Trigger
									>
									<Menu.Portal>
										<Menu.Positioner>
											<Menu.Popup
												><Menu.Item tone="destructive"><RiDeleteBinFill /> Delete</Menu.Item
												></Menu.Popup
											>
										</Menu.Positioner>
									</Menu.Portal>
								</Menu.Root>
							{/snippet}
						</Sidebar.Item>
					{/each}
				</Sidebar.Section>
			</Sidebar.Content>
		</AppShell.Sidebar>
	</AppShell.Root>
</div>
