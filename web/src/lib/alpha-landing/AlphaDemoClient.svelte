<script lang="ts">
	import ChatShell from '$lib/chat/components/ChatShell.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import ChatWindow from '$lib/chat/components/chat/ChatWindow.svelte';
	import { stackOpen, stackMobileOpen } from '$lib/chat/stores/stack';
	import type { Message } from '$lib/chat/types/Message';
	import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { createDemoThreads, demoFootprint, demoThreadModel } from './demo-conversation';
	import { demoCurrentModel, demoModels } from './demo-models';
	import { createDemoShellData, DEMO_ACTIVE_CONVERSATION_ID } from './demo-shell-data';
	import {
		registerAlphaDemoApiInterceptor,
		unregisterAlphaDemoApiInterceptor
	} from './demo-api-interceptor';
	import AlphaDemoSignUp from './AlphaDemoSignUp.svelte';
	import { Button } from '@aipotluck/alpha-ds';
	import RiArrowRightUpLine from '~icons/ri/arrow-right-up-line';
	import RiSparkling2Line from '~icons/ri/sparkling-2-line';
	import RiCloseLine from '~icons/ri/close-line';

	/**
	 * The live /alpha demo: the real chat app on sample data. It behaves like the app wherever it can
	 * — new chat, switching between sample conversations, the model/Private/X-ray pills, search,
	 * appearance — and only asks for sign-up when you SEND a message (the one action that would call a
	 * model). Things that genuinely live in the full app (settings, accounts) get a quiet note with a
	 * link, never a blocking dialog.
	 */
	const threads = createDemoThreads();

	let data = $state(createDemoShellData());
	let activeId = $state<string | undefined>(DEMO_ACTIVE_CONVERSATION_ID);
	let messages = $state<Message[]>(threads[DEMO_ACTIVE_CONVERSATION_ID]());
	let draft = $state('');
	let signupOpen = $state(false);
	let signupPreview = $state('');
	let appNote = $state<string | null>(null);
	let noteTimer: ReturnType<typeof setTimeout> | undefined;
	// The model button names the conversation's model, as in the app: whoever wrote its last answer,
	// or the default before a chat starts.
	const currentModel = $derived(
		demoModels.find((model) => model.id === demoThreadModel(activeId)) ?? demoCurrentModel
	);

	onMount(() => {
		stackOpen.set(false);
		stackMobileOpen.set(false);
		registerAlphaDemoApiInterceptor();
		return () => {
			clearTimeout(noteTimer);
			unregisterAlphaDemoApiInterceptor();
		};
	});

	function resetDemoState() {
		data = createDemoShellData();
		activeId = DEMO_ACTIVE_CONVERSATION_ID;
		messages = threads[DEMO_ACTIVE_CONVERSATION_ID]();
	}

	function onDemoMessage(content: string) {
		signupPreview = content;
		signupOpen = true;
	}

	function onEmbeddedNavigate(intent?: EmbeddedIntent) {
		if (intent?.kind === 'new-chat') {
			activeId = undefined;
			messages = [];
			draft = intent.prompt ?? '';
			return;
		}
		if (intent?.kind === 'signup') {
			signupPreview = '';
			signupOpen = true;
			return;
		}
		if (intent?.kind === 'conversation' && threads[intent.id]) {
			activeId = intent.id;
			messages = threads[intent.id]();
			return;
		}
		appNote =
			intent?.kind === 'app' && intent.label
				? m.chat_demoAppNoteNamed({ feature: intent.label })
				: m.chat_demoAppNote();
		clearTimeout(noteTimer);
		noteTimer = setTimeout(() => (appNote = null), 6000);
	}
</script>

<div class="relative flex h-full min-h-0 flex-col">
	<ChatShell
		bind:data
		embeddedStage
		embeddedDemo
		embeddedActiveConversationId={activeId}
		{onEmbeddedNavigate}
		onEmbeddedDemoReset={resetDemoState}
		demoFootprint={demoFootprint()}
		hasPageSeo
	>
		<ChatWindow
			{messages}
			models={demoModels}
			{currentModel}
			bind:draft
			onmessage={onDemoMessage}
			embeddedDemo
			onDemoForgetEverything={resetDemoState}
			{onEmbeddedNavigate}
		/>
	</ChatShell>

	{#if appNote}
		<!-- A friendly pointer, not a wall: accent mark, what and why, one clear way to the real thing. -->
		<div
			class="pointer-events-auto absolute inset-x-4 bottom-4 z-overlay mx-auto flex max-w-md items-center gap-3 rounded-card border border-accent-1/30 bg-surface-3 p-2 text-fg-1 shadow-popover"
			role="status"
			transition:fly={{ y: 10, duration: 180 }}
			data-demo-app-note
		>
			<span
				class="grid size-9 shrink-0 place-items-center rounded-sharp bg-accent-1/15 text-accent-1-text"
			>
				<RiSparkling2Line aria-hidden="true" class="size-4" />
			</span>
			<span class="flex min-w-0 flex-1 flex-col">
				<span class="line-clamp-2 type-body text-fg-1">{appNote}</span>
				<span class="truncate type-caption text-fg-3">{m.chat_demoAppNoteDetail()}</span>
			</span>
			<Button href="/chat" variant="primary" size="sm" shape="pill" casing="sentence">
				{m.chat_tryAlpha()}
				<RiArrowRightUpLine aria-hidden="true" />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				shape="pill"
				aria-label={m.chat_dismiss()}
				onclick={() => (appNote = null)}
			>
				<RiCloseLine aria-hidden="true" />
			</Button>
		</div>
	{/if}

	<AlphaDemoSignUp bind:open={signupOpen} draftPreview={signupPreview} />
</div>
