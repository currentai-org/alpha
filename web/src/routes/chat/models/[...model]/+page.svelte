<script lang="ts">
	import { page } from "$app/state";
	import { base } from "$lib/chat/paths";
	import { onMount } from "svelte";
	import { usePublicConfig } from "$lib/chat/utils/PublicConfig.svelte";
	import { APP_NAME } from "$lib/chat/constants/app";

	import ChatWindow from "$lib/chat/components/chat/ChatWindow.svelte";
	import NoModelsAvailable from "$lib/chat/components/NoModelsAvailable.svelte";
	import { findCurrentModel } from "$lib/chat/utils/models";
	import { useSettingsStore } from "$lib/chat/stores/settings";
	import { useConversationsStore } from "$lib/chat/stores/conversations.svelte";
	import LinkPromptGate from "$lib/chat/components/LinkPromptGate.svelte";
	import { createLandingSend } from "$lib/chat/utils/landingSend.svelte";
	import { catalogByGatewayId } from "$lib/chat/routing/catalog";
	import { modelPickRequest } from "$lib/chat/routing/choice";

	let { data } = $props();

	const convsStore = useConversationsStore();

	let loading = $state(false);
	let files: File[] = $state([]);
	let draft = $state("");

	const settings = useSettingsStore();
	let modelId = $derived(page.params.model ?? "");
	// The URL's model is only the starting pick. onMount writes it to the settings, and from
	// then on the composer's picker, which writes the settings too, decides the model, as on /chat. (CUR-3295)
	let pageModelApplied = $state(false);
	let activeModelId = $derived(pageModelApplied ? $settings.activeModel || modelId : modelId);
	// findCurrentModel falls back to models[0], undefined when models is empty — see
	// routes/chat/conversation/[id]/+page.svelte's identical guard for the full mechanism. (CUR-1141)
	let currentModel = $derived(findCurrentModel(data.models, activeModelId));
	const publicConfig = usePublicConfig();
	let modelPath = $derived(
		modelId
			.split("/")
			.map((segment) => encodeURIComponent(segment))
			.join("/")
	);

	const landing = createLandingSend({ get: () => draft, set: (text) => (draft = text) });

	function createConversation(message: string) {
		return landing.send({
			message,
			files,
			settings: $settings,
			convsStore,
			pickModel: () => currentModel?.id ?? modelId,
			setLoading: (on) => (loading = on),
		});
	}

	onMount(() => {
		settings.instantSet({ activeModel: modelId });
		// The link's model is picked as if from the picker, so a device left on Auto shows the
		// model this page sends to rather than Auto, and its answer claims no Auto choice it never made. (CUR-4021)
		const picked = catalogByGatewayId(modelId)?.id;
		if (picked) modelPickRequest.set(picked);
		pageModelApplied = true;
	});
</script>

<svelte:head>
	<title>{modelId} - {APP_NAME}</title>
	<meta property="og:title" content="{modelId} - {APP_NAME}" />
	<meta property="og:type" content="website" />
	<meta property="og:description" content="Use {modelId} with {APP_NAME}" />
	<meta
		property="og:image"
		content="{publicConfig.PUBLIC_ORIGIN || page.url.origin}{base}/models/{modelPath}/thumbnail.png"
	/>
	<meta property="og:image:alt" content="{modelId} - {APP_NAME}" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="648" />
	<meta property="og:url" content={page.url.href} />
	<meta property="og:site_name" content={APP_NAME} />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content="{modelId} - {APP_NAME}" />
	<meta name="twitter:description" content="Use {modelId} with {APP_NAME}" />
	<meta
		name="twitter:image"
		content="{publicConfig.PUBLIC_ORIGIN || page.url.origin}{base}/models/{modelPath}/thumbnail.png"
	/>
	<meta name="twitter:image:alt" content="{modelId} - {APP_NAME}" />
</svelte:head>

{#if currentModel}
	{@const model = currentModel}
	<ChatWindow
		onmessage={(message) => createConversation(message)}
		onstop={landing.stop}
		{loading}
		pending={landing.pendingMessages.length > 0}
		messages={landing.pendingMessages}
		currentModel={model}
		models={data.models}
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
	modelName={modelId}
/>
