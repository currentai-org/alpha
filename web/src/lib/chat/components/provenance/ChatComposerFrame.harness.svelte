<script lang="ts">
	import { setContext } from 'svelte';
	import { writable } from 'svelte/store';
	import { ThemeProvider } from '@aipotluck/alpha-ds';
	import { catalog } from '$lib/chat/routing/catalog';
	import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
	import ChatComposerFrame from './ChatComposerFrame.svelte';

	let {
		onEmbeddedNavigate,
		currentModelId,
		started = false,
		chatModelId
	}: {
		onEmbeddedNavigate: (intent?: EmbeddedIntent) => void;
		currentModelId?: string;
		/** Whether a conversation is already under way — the app passes `messages.length > 0`. */
		started?: boolean;
		/** The model a started conversation is on, held whatever is picked, as the conversation page holds it. */
		chatModelId?: string;
	} = $props();

	const live = catalog.filter((m) => m.status === 'live' && m.gatewayId).map((m) => m.gatewayId!);
	const current = currentModelId ?? live[0];
	// The deployment's default is the first served id, as `models[0]` is on the server.
	const served = [current, ...live.filter((id) => id !== current)];

	// The picker reads the settings store (the model chosen in Settings, used while Auto is off); the app
	// provides it from ChatShell. The field the composer reads, and the setter a pick calls, are enough here.
	// Before a chat starts the app's current model follows the pick (ChatWindow's currentModel), so
	// the harness passes the setting through rather than pinning it.
	const settings = writable({ activeModel: current });
	setContext('settings', {
		subscribe: settings.subscribe,
		instantSet: async (patch: { activeModel?: string }) => settings.update((s) => ({ ...s, ...patch }))
	});
</script>

<!-- The composer sits at the foot of the window, as in the app, so the model menu rises over its button. -->
<ThemeProvider mode="dark" theme="alpha" class="flex h-screen items-end justify-center p-6">
	<div class="w-full max-w-2xl">
		<ChatComposerFrame
			currentModelId={chatModelId ?? $settings.activeModel}
			servedIds={served}
			{started}
			embeddedDemo
			{onEmbeddedNavigate}
		>
			{#snippet children(modelPicker)}
				<form class="composer-shell flex h-24 items-end justify-end border p-2">
					<textarea aria-label="Message AI Potluck" class="flex-1"></textarea>
					{@render modelPicker()}
				</form>
			{/snippet}
		</ChatComposerFrame>
	</div>
</ThemeProvider>
