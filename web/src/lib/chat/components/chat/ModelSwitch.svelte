<script lang="ts">
	import { UrlDependency } from "$lib/chat/types/UrlDependency";
	import { safeInvalidate } from "$lib/chat/utils/safeInvalidate";
	import { useConversationsStore } from "$lib/chat/stores/conversations.svelte";
	import { page } from "$app/state";
	import { base } from "$lib/chat/paths";
	import type { Model } from "$lib/chat/types/Model";

	interface Props {
		models: Model[];
		currentModel: Model;
	}

	let { models, currentModel }: Props = $props();

	const convsStore = useConversationsStore();

	// Writable $derived, not $state + $effect.pre (CUR-219). It is `bind:value` on the <select> below,
	// so it has to stay assignable — and Svelte 5 writable $derived is assignable while still
	// re-deriving when `currentModel`/`models` change. A $state + $effect.pre pairing has a real ordering hazard, not
	// just extra lines: an effect that writes the same state it reads from props can land AFTER the user
	// picks something and quietly reset the selection. With $derived that sequencing is defined.
	let selectedModelId = $derived(
		models.map((m) => m.id).includes(currentModel.id) ? currentModel.id : models[0].id
	);

	async function handleModelChange() {
		if (!page.params.id) return;

		try {
			const response = await fetch(`${base}/conversation/${page.params.id}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ model: selectedModelId }),
			});

			if (!response.ok) {
				throw new Error("Failed to update model");
			}

			await Promise.all([safeInvalidate(UrlDependency.Conversation), convsStore.refresh()]);
		} catch (error) {
			console.error(error);
		}
	}
</script>

<div
	class="mx-auto mt-0 flex w-fit flex-col items-center justify-center gap-2 rounded-sharp border border-[var(--ap-rule)] bg-gray-500/20 p-4"
>
	<span>
		This model is no longer available. Switch to a new one to continue this conversation:
	</span>
	<div class="flex items-center space-x-2">
		<select
			bind:value={selectedModelId}
			class="rounded-sharp bg-[var(--ap-paper)] px-2 py-1 max-sm:max-w-32"
		>
			{#each models as model (model.id)}
				<option value={model.id}>{model.name}</option>
			{/each}
		</select>
		<button
			onclick={handleModelChange}
			disabled={selectedModelId === currentModel.id}
			class="rounded-sharp bg-[var(--ap-paper)] px-2 py-1"
		>
			Accept
		</button>
	</div>
</div>
