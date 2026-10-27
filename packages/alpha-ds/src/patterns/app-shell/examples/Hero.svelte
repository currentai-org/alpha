<script lang="ts">
	import {
		AppShell,
		Button,
		Composer,
		EmptyState,
		EmptyStateSuggestion,
		Sidebar,
		ThreadHeader
	} from '@aipotluck/alpha-ds';
	import RiChatNewLine from '~icons/ri/chat-new-line';
	import RiSearchLine from '~icons/ri/search-line';
	import RiSettings3Line from '~icons/ri/settings-3-line';
	import RiStackLine from '~icons/ri/stack-line';
	import RiCloseLine from '~icons/ri/close-line';

	let collapsed = $state(false);
	let sidePanelOpen = $state(false);
	let draft = $state('');
	const recents = ['Open speech projects', 'EU AI Act catalog gaps', 'Router provenance check'];
</script>

<div class="h-136 overflow-hidden border-2 border-line-strong">
	<AppShell.Root bind:collapsed bind:sidePanelOpen>
		<AppShell.Sidebar>
			<Sidebar.Header><span class="type-label">Alpha</span></Sidebar.Header>
			<Sidebar.Actions>
				<Sidebar.Item icon={RiChatNewLine} emphasis label="New chat" current>New chat</Sidebar.Item>
				<Sidebar.Item icon={RiSearchLine} emphasis label="Search">Search</Sidebar.Item>
			</Sidebar.Actions>
			<Sidebar.Content>
				<Sidebar.Section label="Today">
					{#each recents as title (title)}
						<Sidebar.Item label={title}>{title}</Sidebar.Item>
					{/each}
				</Sidebar.Section>
			</Sidebar.Content>
			<Sidebar.Footer>
				<Sidebar.Item icon={RiSettings3Line} label="Settings">Settings</Sidebar.Item>
			</Sidebar.Footer>
		</AppShell.Sidebar>
		<AppShell.Main>
			<ThreadHeader title="New conversation">
				{#snippet actions()}
					<Button variant="ghost" size="sm" onclick={() => (sidePanelOpen = !sidePanelOpen)}
						><RiStackLine /> XRAY</Button
					>
				{/snippet}
			</ThreadHeader>
			<div class="flex flex-1 items-center overflow-y-auto py-8">
				<EmptyState
					title="What do you want to know?"
					description="Answers name the model that served them."
				>
					<Composer.Root bind:value={draft}>
						<Composer.Input />
						<Composer.Toolbar><Composer.Tools /><Composer.Send /></Composer.Toolbar>
					</Composer.Root>
					{#snippet suggestions()}
						<EmptyStateSuggestion onclick={() => (draft = 'Which open models speak Swahili?')}
							>Which open models speak Swahili?</EmptyStateSuggestion
						>
						<EmptyStateSuggestion onclick={() => (draft = 'Map the open speech stack')}
							>Map the open speech stack</EmptyStateSuggestion
						>
					{/snippet}
				</EmptyState>
			</div>
		</AppShell.Main>
		<AppShell.SidePanel label="XRAY view">
			<div class="flex h-header items-center justify-between border-b border-line-3 px-3">
				<span class="type-nav">XRAY view</span>
				<Button
					variant="accent"
					size="icon-sm"
					aria-label="Close XRAY"
					onclick={() => (sidePanelOpen = false)}><RiCloseLine /></Button
				>
			</div>
			<div class="p-3 type-caption text-fg-2">The stack that served this answer.</div>
		</AppShell.SidePanel>
	</AppShell.Root>
</div>
