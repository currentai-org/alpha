<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
	import { untrack } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { AppShell, Toast, useToastManager } from '@aipotluck/alpha-ds';
	import NavMenu from '$lib/chat/components/NavMenu.svelte';
	import { error } from '$lib/chat/stores/errors';
	import { welcomeOnScreen } from '$lib/chat/stores/welcomeOnScreen.svelte';
	import type { ConvSidebar } from '$lib/chat/types/ConvSidebar';

	let {
		conversations,
		conversationsLoading = false,
		isNavCollapsed = $bindable(false),
		embeddedDemo = false,
		embeddedActiveConversationId,
		onEmbeddedNavigate,
		ondeleteConversation,
		onrenameConversation,
		currentError,
		children
	}: {
		conversations: ConvSidebar[];
		conversationsLoading?: boolean;
		isNavCollapsed?: boolean;
		embeddedDemo?: boolean;
		embeddedActiveConversationId?: string;
		onEmbeddedNavigate?: (intent?: EmbeddedIntent) => void;
		ondeleteConversation?: (id: string) => void;
		onrenameConversation?: (id: string, title: string) => void;
		currentError?: string;
		children?: import('svelte').Snippet;
	} = $props();

	// The chat's error goes to the app's toast stack (bottom right on desktop, the top on phones).
	// ChatShell owns how long it stays; closing it clears the error. The welcome shows the error in its
	// own column while it is up (CUR-2883).
	const toasts = useToastManager();
	$effect(() => {
		const message = currentError && !welcomeOnScreen.open ? currentError : undefined;
		// The manager's list is state the add reads and writes; untracked, so this follows only the error.
		untrack(() => {
			if (message)
				toasts.add({
					id: 'chat-error',
					type: 'error',
					title: message,
					timeout: 0,
					testId: 'chat-error-toast',
					onDismiss: () => error.set(undefined)
				});
			else toasts.close('chat-error');
		});
	});

	// Mobile drawer state lives here so any navigation closes it.
	let mobileOpen = $state(false);
	beforeNavigate(() => {
		mobileOpen = false;
	});
</script>

<!--
  App frame from the design system: persistent sidebar (icon rail when collapsed,
  drawer on mobile) | conversation column. The conversation column (ChatWindow) renders its own
  ThreadHeader and the XRAY side panel.
-->
<!-- `.chat-root` is the chat subtree's CSS hook (styles/main.css); display:contents keeps it out of layout. -->
<div class="chat-root contents">
<AppShell.Root bind:collapsed={isNavCollapsed} bind:mobileOpen>
	<AppShell.Sidebar label={m.product_conversations()} closeLabel={m.product_closeSidebar()} resizeLabel={m.product_resizeSidebar()} dragOpenLabel={m.product_dragOpenSidebar()} resizeTitle={m.chat_sidebarResizeTitle()} dragOpenTitle={m.chat_sidebarDragOpenTitle()}>
		<NavMenu
			{conversations}
			loading={conversationsLoading}
			{embeddedDemo}
			{embeddedActiveConversationId}
			{onEmbeddedNavigate}
			{ondeleteConversation}
			{onrenameConversation}
		/>
	</AppShell.Sidebar>

	<AppShell.Main>
		{@render children?.()}
		<!-- Phones: below the site and thread headers, so a toast never covers the title or the session
		     footprint, where "Forget everything" lives (CUR-2160). Desktop: above a docked composer, which
		     publishes --toast-clearance (ChatWindow), so a toast never covers Send. -->
		<Toast.Viewport position="corner" class="max-md:top-header max-md:mt-site-header" />
	</AppShell.Main>
</AppShell.Root>
</div>
