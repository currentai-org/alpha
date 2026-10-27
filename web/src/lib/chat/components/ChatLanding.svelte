<script lang="ts">
	import { page } from '$app/state';

	import ChatWindow from '$lib/chat/components/chat/ChatWindow.svelte';
	import { createLandingSend } from '$lib/chat/utils/landingSend.svelte';
	import { newChatRequests } from '$lib/chat/stores/newChat';
	import { useSettingsStore } from '$lib/chat/stores/settings.js';
	import { useConversationsStore } from '$lib/chat/stores/conversations.svelte';
	import { findCurrentModel } from '$lib/chat/utils/models';
	import { loading } from '$lib/chat/stores/loading.js';
	import LinkPromptGate from '$lib/chat/components/LinkPromptGate.svelte';
	import ChatShellSkeleton from '$lib/chat/components/ChatShellSkeleton.svelte';
	import NoModelsAvailable from '$lib/chat/components/NoModelsAvailable.svelte';
	import type { GETModelsResponse } from '$lib/chat/server/api/types';
	import { AUTO, modelChoice, resolveModel } from '$lib/chat/routing/choice';
	import { busyHere, busyNow, serverBusy, serverBusyNow } from '$lib/chat/routing/busyHere';
	import { m } from '$lib/paraglide/messages.js';
	import {
		activeBenchmarks,
		activeRoutingConfig,
		analysisFor,
		autoRouteNote,
		pendingAutoRoute
	} from '$lib/chat/routing/state';

	// Rendered as a child of ChatShell (routes/chat/+layout.svelte), so
	// its useSettingsStore()/useConversationsStore() calls resolve the context ChatShell sets up.
	let {
		models
	}: {
		models: GETModelsResponse;
	} = $props();

	const convsStore = useConversationsStore();

	let files: File[] = $state([]);
	let draft = $state('');

	// New chat on this page navigates nowhere, so a press since mount drops what is attached.
	// The draft stays: it is the person's own typing, and New chat on the empty composer never cleared it. (CUR-3052)
	let newChatSeen = $newChatRequests;
	$effect(() => {
		if ($newChatRequests === newChatSeen) return;
		newChatSeen = $newChatRequests;
		files = [];
	});

	const settings = useSettingsStore();

	const landing = createLandingSend({ get: () => draft, set: (text) => (draft = text) });

	function createConversation(message: string) {
		return landing.send({
			message,
			files,
			settings: $settings,
			convsStore,
			// With Auto on (the `auto-routing` flag), the composer's model pill decides first: Auto routes
			// on the message's language and task size (routing/), reusing the composer's finished analysis
			// when it matches the message, or a model picked from its Advanced list. Either only ever yields
			// a SERVED id; when it yields nothing (nothing suitable is served), and always with Auto off, the
			// rule is $settings.activeModel if valid, else the first model.
			pickModel: () => {
				const validModels = models.map((model: GETModelsResponse[number]) => model.id);
				// A photo goes only to a model that reads photos when Auto chooses, as the composer forecast
				// said (ChatComposerFrame's photoRouting): a text-only model would answer without it.
				const photoReaders = models
					.filter((model: GETModelsResponse[number]) => model.multimodal === true)
					.map((model: GETModelsResponse[number]) => model.id);
				const photoRouting =
					page.data.autoRoutingEnabled === true &&
					$modelChoice === AUTO &&
					files.some((file) => file.type.startsWith('image/')) &&
					photoReaders.length > 0;
				const routeIds = photoRouting ? photoReaders : validModels;
				const resolved = page.data.autoRoutingEnabled
					? resolveModel($modelChoice, message, routeIds, {
							analysis: analysisFor(message),
							benchmarks: $activeBenchmarks,
							config: $activeRoutingConfig,
							// The same busy list the composer's forecast routed around. (CUR-4043)
							busy: busyNow(serverBusyNow(page.data.busyModels as string[] | undefined, $serverBusy), $busyHere)
						})
					: undefined;
				// A pick that isn't served stops the send; sendFromLanding shows this and puts the
				// draft back. Falling through would answer from a model the person didn't pick. (CUR-4073)
				if (resolved?.unavailable) throw new Error(m.chat_pickedModelUnavailable({ model: resolved.unavailable }));
				// Auto's choice travels with the message so the answer's X-ray can say so. (CUR-3944)
				pendingAutoRoute.set(
					resolved?.modelId && resolved.route
						? { text: message.trim(), note: autoRouteNote(resolved.route) }
						: null
				);
				const routed = resolved?.modelId;
				if (routed) return routed;
				if (photoRouting)
					return photoReaders.includes($settings.activeModel) ? $settings.activeModel : photoReaders[0];
				if (validModels.includes($settings.activeModel)) return $settings.activeModel;
				return models[0].id;
			},
			setLoading: (on) => ($loading = on),
		});
	}

	let currentModel = $derived(findCurrentModel(models, $settings.activeModel));
</script>

{#if models === undefined}
	<ChatShellSkeleton />
{:else if currentModel}
	{@const model = currentModel}
	<ChatWindow
		onmessage={(message) => createConversation(message)}
		onstop={landing.stop}
		loading={$loading}
		pending={landing.pendingMessages.length > 0}
		messages={landing.pendingMessages}
		currentModel={model}
		{models}
		bind:files
		bind:draft
	/>
{:else}
	<NoModelsAvailable />
{/if}
<!-- CUR-2644: a deep link's prompt and attachments wait for the visitor to confirm. -->
<LinkPromptGate
	attach={(loaded) => (files = loaded)}
	fill={(prompt) => {
		if (!draft) draft = prompt;
	}}
	send={createConversation}
/>
