<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { page } from "$app/state";
	import { Badge, Button, Switch } from "@aipotluck/alpha-ds";
	import { base } from "$lib/chat/paths";
	import { useSettingsStore } from "$lib/chat/stores/settings";
	import { catalogByGatewayId, orgs } from "$lib/chat/routing/catalog";
	import OrgLogo from "$lib/chat/components/provenance/OrgLogo.svelte";
	import RiArrowRightLine from "~icons/ri/arrow-right-line";

	// Settings → Model settings (developer tools): every model the registry serves, with its feature
	// switches side by side. A switch overrides what the model advertises, for this account; the
	// model's own page (system prompt, activation) is one click away.
	type Model = {
		id: string;
		displayName?: string;
		name?: string;
		unlisted?: boolean;
		multimodal?: boolean;
		supportsReasoning?: boolean;
		supportsArtifacts?: boolean;
	};
	type OverrideKey = "multimodalOverrides" | "reasoningOverrides" | "artifactsOverrides" | "hidePromptExamples";

	const settings = useSettingsStore();
	const models = $derived(((page.data.models ?? []) as Model[]).filter((mdl) => !mdl.unlisted));

	const FEATURES: { key: OverrideKey; label: string; hint: string; advertised: (mdl: Model) => boolean }[] = $derived([
		{ key: "multimodalOverrides", label: m.models_imageInput(), hint: m.models_imageInputHint(), advertised: (mdl) => Boolean(mdl.multimodal) },
		{ key: "reasoningOverrides", label: m.models_reasoning(), hint: m.models_reasoningHint(), advertised: (mdl) => Boolean(mdl.supportsReasoning) },
		{ key: "artifactsOverrides", label: m.models_artifacts(), hint: m.models_artifactsHint(), advertised: (mdl) => Boolean(mdl.supportsArtifacts) },
		{ key: "hidePromptExamples", label: m.models_hideExamples(), hint: m.models_hideExamplesHint(), advertised: () => false },
	]);

	function value(key: OverrideKey, mdl: Model): boolean {
		return ($settings[key] as Record<string, boolean> | undefined)?.[mdl.id] ?? FEATURES.find((f) => f.key === key)!.advertised(mdl);
	}
	function set(key: OverrideKey, mdl: Model, v: boolean) {
		settings.update((s) => ({ ...s, [key]: { ...(s[key] as Record<string, boolean> | undefined), [mdl.id]: v } }));
	}
	function overridden(mdl: Model): boolean {
		return FEATURES.some((f) => (($settings[f.key] as Record<string, boolean> | undefined)?.[mdl.id] ?? f.advertised(mdl)) !== f.advertised(mdl));
	}
	function reset(mdl: Model) {
		settings.update((s) => {
			const next = { ...s };
			for (const f of FEATURES) {
				const map = { ...(s[f.key] as Record<string, boolean> | undefined) };
				delete map[mdl.id];
				(next as Record<string, unknown>)[f.key] = map;
			}
			return next;
		});
	}
</script>

<div class="flex flex-col gap-6" data-model-settings>
	<div class="flex flex-col gap-1">
		<div class="flex items-center gap-2">
			<Badge>Dev</Badge>
			<p class="type-caption text-fg-3">{m.models_devVisible()}</p>
		</div>
		<p class="type-body text-fg-2">
			{m.models_intro()}
		</p>
	</div>

	<ul class="flex flex-col gap-3">
		{#each models as mdl (mdl.id)}
			{@const entry = catalogByGatewayId(mdl.id)}
			<li class="flex flex-col gap-3 border border-line-2 p-4 rounded-card" data-model-settings-row={mdl.id}>
				<div class="flex items-center gap-3">
					{#if entry}<OrgLogo org={orgs[entry.maker]} size="md" />{/if}
					<div class="flex min-w-0 flex-1 flex-col">
						<span class="truncate type-body text-fg-1">{mdl.displayName ?? mdl.name ?? mdl.id}</span>
						<span class="truncate type-code text-fg-3">{mdl.id}</span>
					</div>
					{#if mdl.id === $settings.activeModel}<Badge>{m.models_default()}</Badge>{/if}
					{#if overridden(mdl)}
						<Button variant="ghost" size="sm" casing="sentence" onclick={() => reset(mdl)}>{m.models_reset()}</Button>
					{/if}
				</div>
				<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
					{#each FEATURES as f (f.key)}
						<label class="flex items-center justify-between gap-3 border border-line-1 px-3 py-2 rounded-sharp">
							<span class="flex min-w-0 flex-col">
								<span class="type-body text-fg-1">{f.label}</span>
								<span class="type-caption text-fg-3">
									{f.hint}{f.key !== "hidePromptExamples" ? ` · ${f.advertised(mdl) ? m.models_advertisedOn() : m.models_advertisedOff()}` : ""}
								</span>
							</span>
							<Switch.Root
								checked={value(f.key, mdl)}
								onCheckedChange={(v: boolean) => set(f.key, mdl, v)}
								aria-label={m.models_featureFor({ feature: f.label, model: mdl.displayName ?? mdl.id })}
							>
								<Switch.Thumb />
							</Switch.Root>
						</label>
					{/each}
				</div>
				<a
					href={`${base}/settings/${mdl.id}`}
					class="inline-flex items-center gap-1.5 self-start type-caption text-fg-2 underline decoration-line-3 underline-offset-2 hover:text-fg-1"
				>
					{m.models_systemPromptMore()} <RiArrowRightLine aria-hidden="true" class="size-3.5" />
				</a>
			</li>
		{/each}
	</ul>
</div>
