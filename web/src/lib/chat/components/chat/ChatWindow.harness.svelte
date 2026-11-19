<script lang="ts">
	import { setContext } from 'svelte';
	import { writable } from 'svelte/store';
	import { catalog } from '$lib/chat/routing/catalog';
	import type { Model } from '$lib/chat/types/Model';
	import { createSessionFootprintStore } from '$lib/chat/stores/sessionFootprint.svelte';
	import { createConversationsStore } from '$lib/chat/stores/conversations.svelte';
	import { getConfigManager } from '$lib/chat/utils/PublicConfig.svelte';
	import ChatWindow from './ChatWindow.svelte';

	// The stores ChatShell provides to everything under it.
	setContext('publicConfig', getConfigManager({}));
	createSessionFootprintStore();
	createConversationsStore();

	// One served model that reads photos, so the composer would offer images as well as text
	// wherever uploads are allowed at all.
	const id = catalog.find((m) => m.status === 'live' && m.gatewayId)!.gatewayId!;
	const model = {
		id,
		name: id,
		displayName: id,
		multimodal: true,
		multimodalAcceptedMimetypes: ['image/png', 'image/jpeg'],
		parameters: {},
		preprompt: '',
		promptExamples: [],
		unlisted: false
	} as unknown as Model;

	// ChatShell provides the settings store; the fields the window reads, and no-op setters, are enough here.
	const settings = writable({
		activeModel: id,
		multimodalOverrides: {},
		reasoningOverrides: {},
		reasoningEffortOverrides: {},
		customPrompts: {},
		hidePromptExamples: {},
		directPaste: false
	});
	setContext('settings', {
		subscribe: settings.subscribe,
		set: settings.set,
		update: settings.update,
		instantSet: async (patch: Record<string, unknown>) => settings.update((s) => ({ ...s, ...patch })),
		initValue: async () => {},
		setField: async () => {},
		setFields: async () => {}
	});
</script>

<ChatWindow currentModel={model} models={[model]} />
