<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	// Styled from design-system.md directly (--ap-* tokens), matching account/+page.svelte and
	// the (nav)/+layout.svelte shell (CUR-595).
	import { page } from "$app/state";
	import { base } from "$lib/chat/paths";

	import type { BackendModel } from "$lib/chat/server/models";
	import type { Model } from "$lib/chat/types/Model";
	import IconOmni from "$lib/chat/components/icons/IconOmni.svelte";
	import { useSettingsStore } from "$lib/chat/stores/settings";
	import { modelChoice } from "$lib/chat/routing/choice";
	import RiArrowUpRight from "~icons/ri/arrow-right-up-line";
	import RiChatNewLine from "~icons/ri/chat-new-line";
	import RiRefreshLine from "~icons/ri/refresh-line";
	import OrgLogo from "$lib/chat/components/provenance/OrgLogo.svelte";
	import { catalogByGatewayId, orgs } from "$lib/chat/routing/catalog";

	import { usePublicConfig } from "$lib/chat/utils/PublicConfig.svelte";
	import Switch from "$lib/chat/components/Switch.svelte";

	const publicConfig = usePublicConfig();
	const settings = useSettingsStore();
	const modelId = $derived(page.params.model ?? "");

	// Functional bindings for nested settings (Svelte 5):
	// Avoid binding directly to $settings.*[modelId]; write via store update
	function getMultimodalOverride() {
		return $settings.multimodalOverrides?.[modelId] ?? Boolean(model?.multimodal);
	}
	function setMultimodalOverride(v: boolean) {
		settings.update((s) => ({
			...s,
			multimodalOverrides: { ...s.multimodalOverrides, [modelId]: v },
		}));
	}
	function getHidePromptExamples() {
		return $settings.hidePromptExamples?.[modelId] ?? false;
	}
	function setHidePromptExamples(v: boolean) {
		settings.update((s) => ({
			...s,
			hidePromptExamples: { ...s.hidePromptExamples, [modelId]: v },
		}));
	}

	function getReasoningOverride() {
		return $settings.reasoningOverrides?.[modelId] ?? Boolean(model?.supportsReasoning);
	}
	function setReasoningOverride(v: boolean) {
		settings.update((s) => ({
			...s,
			reasoningOverrides: { ...s.reasoningOverrides, [modelId]: v },
		}));
	}

	function getArtifactsOverride() {
		return $settings.artifactsOverrides?.[modelId] ?? Boolean(model?.supportsArtifacts);
	}
	function setArtifactsOverride(v: boolean) {
		settings.update((s) => ({
			...s,
			artifactsOverrides: { ...s.artifactsOverrides, [modelId]: v },
		}));
	}

	function getCustomPrompt() {
		return $settings.customPrompts?.[modelId] ?? "";
	}
	function setCustomPrompt(v: string) {
		settings.update((s) => ({
			...s,
			customPrompts: { ...s.customPrompts, [modelId]: v },
		}));
	}
	function getCustomPromptEnabled() {
		return $settings.customPromptsEnabled?.[modelId] ?? true;
	}
	function setCustomPromptEnabled(v: boolean) {
		settings.update((s) => ({
			...s,
			customPromptsEnabled: { ...s.customPromptsEnabled, [modelId]: v },
		}));
	}

	$effect(() => {
		const defaultPreprompt =
			page.data.models.find((el: BackendModel) => el.id === modelId)?.preprompt || "";
		settings.initValue("customPrompts", modelId, defaultPreprompt);
	});

	let hasCustomPreprompt = $derived(
		$settings.customPrompts[modelId] !==
			page.data.models.find((el: BackendModel) => el.id === modelId)?.preprompt
	);

	let model = $derived(page.data.models.find((el: BackendModel) => el.id === modelId));
	// The client's model list carries the weak-spot sentence (layoutData.ts); BackendModel does not.
	let knownWeakSpot = $derived((model as Pick<Model, "knownWeakSpot"> | undefined)?.knownWeakSpot);
	// The maker's mark, as on the composer picker's row, beside the sentence that names the model.
	let weakSpotMaker = $derived.by(() => {
		const entry = catalogByGatewayId(modelId);
		return entry ? orgs[entry.maker] : undefined;
	});

	// multimodalOverrides intentionally has no initValue: the getter falls back
	// to the model's advertised capability, so upstream capability changes flow through.

	// Ensure hidePromptExamples has an entry for this model so the switch can bind safely
	$effect(() => {
		settings.initValue("hidePromptExamples", modelId, false);
	});

	// Ensure customPromptsEnabled has an entry for this model (default enabled)
	$effect(() => {
		settings.initValue("customPromptsEnabled", modelId, true);
	});

	const pillClass =
		"inline-flex items-center gap-1.5 border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-2.5 py-1 text-[length:var(--ap-text-2)] text-[color:var(--ap-ink)] transition-colors hover:bg-white/15";
	const cardClass = "border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 rounded-card";
</script>

<!-- Key on modelId so the DOM is rebuilt when navigating between models:
     reused switches/textareas would otherwise animate to the new model's values -->
{#key modelId}
	<div class="flex flex-col items-start text-[length:var(--ap-text-3)] text-[color:var(--ap-ink)]">
		<div class="mb-4 flex flex-col gap-px">
			<!-- The model name is the settings layout's PageHeader title. -->

			{#if model.description}
				<p class="line-clamp-2 text-[length:var(--ap-text-2)] whitespace-pre-wrap text-[color:var(--ap-ink-3)]">
					{model.description}
				</p>
			{/if}
			<!-- CUR-3911: a model's measured weak spot, as one quiet line here and never on
			     the picker row. The words are modelWeakSpots.ts's; a model with none shows nothing. -->
			{#if knownWeakSpot}
				<p data-known-weak-spot class="mt-2 flex items-start gap-1.5 type-caption text-fg-2">
					{#if weakSpotMaker}<OrgLogo org={weakSpotMaker} size="xs" />{/if}
					<span><span class="sr-only">Known weak spot: </span>{knownWeakSpot}</span>
				</p>
			{/if}
		</div>

		<!-- Actions -->
		<div class="mb-4 flex flex-wrap items-center gap-1.5">
			<button
				class="inline-flex w-fit items-center gap-1.5 rounded-full bg-[var(--ap-ink)] px-3 py-1.5 text-[length:var(--ap-text-2)] text-[color:var(--ap-paper)] transition-opacity hover:opacity-85"
				name="Activate model"
				onclick={async (e) => {
					e.stopPropagation();
					// AWAIT before navigating — `${base}` (bare "/chat") has no page of its own; it only
					// resolves via a server-side redirect chain (currently /chat -> /alpha/chat, itself
					// CMS-configured). goto() is a client-side SPA transition that can't resolve a route
					// with no client-side page, so it falls through to a hard reload — which aborts
					// any not-yet-complete fetch, including this one, silently dropping the activeModel
					// write. A real navigation (window.location, not goto) both waits for the setting to
					// actually persist AND correctly follows whatever that redirect chain currently
					// resolves to — same pattern NavMenu.svelte already uses for this same destination.
					await settings.instantSet({
						activeModel: modelId,
					});
					// The composer's own choice follows, so Auto stops overriding a model picked here.
					modelChoice.set(catalogByGatewayId(modelId)?.id ?? modelId);
					window.location.href = `${base}/`;
				}}
			>
				<RiChatNewLine class="size-3.5" />
				<!-- CUR-1772: "New chat" named the consequence, not the commit. This is the ONLY control
				     that writes `activeModel`, and a person arrives here from the model picker believing
				     they already chose — the picker's own row click navigates rather than selects. A
				     label naming a different action would leave no step in that chain saying "this is how you
				     choose a model". The `name` attribute above says "Activate model". -->
				{m.models_useThis()}
			</button>

			{#if model.modelUrl}
				<a
					href={model.modelUrl || "https://huggingface.co/" + model.name}
					target="_blank"
					rel="noreferrer"
					class={pillClass}
				>
					<RiArrowUpRight class="size-3.5 shrink-0" />
					{m.models_modelPage()}
				</a>
			{/if}

			{#if model.datasetName || model.datasetUrl}
				<a
					href={model.datasetUrl || "https://huggingface.co/datasets/" + model.datasetName}
					target="_blank"
					rel="noreferrer"
					class={pillClass}
				>
					<RiArrowUpRight class="size-3.5 shrink-0" />
					{m.models_datasetPage()}
				</a>
			{/if}

			{#if model.websiteUrl}
				<a href={model.websiteUrl} target="_blank" class={pillClass} rel="noreferrer">
					<RiArrowUpRight class="size-3.5 shrink-0" />
					{m.models_website()}
				</a>
			{/if}

		</div>

		<div class="relative flex w-full flex-col gap-2">
			{#if model?.isRouter}
				<p class="mt-2 mb-3 border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-2 text-[length:var(--ap-text-2)] rounded-card">
					<IconOmni classNames="-translate-y-px" />
					{m.models_routerNote({ model: model.displayName })}
				</p>
			{/if}
			<div class="flex w-full flex-row items-center justify-between">
				<h3 class="text-[length:var(--ap-text-3)] font-semibold">{m.models_systemPrompt()}</h3>
				<div class="flex items-center gap-2">
					<div class="flex items-center gap-1.5 text-[length:var(--ap-text-1)] font-medium text-[color:var(--ap-ink-3)] select-none">
						<span>{m.models_enabled()}</span>
						<Switch
							name="customPromptEnabled" label={m.models_customPromptEnabled()}
							size="sm"
							bind:checked={getCustomPromptEnabled, setCustomPromptEnabled}
						/>
					</div>
					{#if hasCustomPreprompt}
						<button
							type="button"
							aria-label={m.models_resetPrompt()}
							title={m.models_resetDefault()}
							class="grid size-6 place-items-center text-[color:var(--ap-ink-3)] transition-colors hover:bg-white/15 hover:text-[color:var(--ap-ink)]"
							onclick={(e) => {
								e.stopPropagation();
								settings.update((s) => ({
									...s,
									customPrompts: { ...s.customPrompts, [modelId]: model.preprompt },
								}));
							}}
						>
							<RiRefreshLine class="size-3.5" />
						</button>
					{/if}
				</div>
			</div>

			<textarea
				aria-label={m.models_customPrompt()}
				rows="8"
				disabled={!getCustomPromptEnabled()}
				class="scrollbar-custom w-full resize-none border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] p-2 text-[length:var(--ap-text-2)] text-[color:var(--ap-ink)] transition-opacity"
				class:opacity-40={!getCustomPromptEnabled()}
				bind:value={getCustomPrompt, setCustomPrompt}
			></textarea>
			<!-- Capabilities -->
			<div class="mt-3 {cardClass}">
				<div class="divide-y divide-[var(--ap-border-1)]">
					<!-- Tool calling toggle removed: tools/MCP are stripped in this build, so the override is inert. -->
					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[length:var(--ap-text-3)] font-medium">
								{m.models_multimodal()}
							</div>
							<p class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-3)]">
								{#if publicConfig.isHuggingChat}
									{m.models_providerDecides()}
								{:else}
									{m.models_multimodalHelp()}
								{/if}
							</p>
						</div>
						<Switch
							name="forceMultimodal" label={m.models_multimodal()}
							disabled={publicConfig.isHuggingChat}
							bind:checked={getMultimodalOverride, setMultimodalOverride}
						/>
					</div>

					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[length:var(--ap-text-3)] font-medium">{m.models_reasoningEffort()}</div>
							<p class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-3)]">
								{#if publicConfig.isHuggingChat}
									{m.models_providerDecides()}
								{:else}
									{m.models_reasoningHelp()}
								{/if}
							</p>
						</div>
						<Switch
							name="forceReasoning" label={m.models_reasoningEffort()}
							disabled={publicConfig.isHuggingChat}
							bind:checked={getReasoningOverride, setReasoningOverride}
						/>
					</div>

					<div class="flex items-start justify-between py-3">
						<div>
							<div class="flex items-center gap-1.5 text-[length:var(--ap-text-3)] font-medium">
								{m.models_artifacts()}
							</div>
							<p class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-3)]">
								{m.models_artifactsHelp()}
							</p>
						</div>
						<!-- Not provider-determined, so user-editable even on HuggingChat -->
						<Switch name="artifactsOverride" label={m.models_artifacts()} bind:checked={getArtifactsOverride, setArtifactsOverride} />
					</div>

					{#if model?.isRouter}
						<div class="flex items-start justify-between py-3">
							<div>
								<div class="text-[length:var(--ap-text-3)] font-medium">{m.models_hidePromptExamples()}</div>
								<p class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-3)]">
									{m.models_hidePromptExamplesHelp()}
								</p>
							</div>
							<Switch
								name="hidePromptExamples" label={m.models_hidePromptExamples()}
								bind:checked={getHidePromptExamples, setHidePromptExamples}
							/>
						</div>
					{/if}
				</div>
			</div>

			<!-- Tokenizer-based token counting disabled in this build -->
		</div>
	</div>
{/key}
