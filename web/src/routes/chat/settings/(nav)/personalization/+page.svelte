<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import { getLocale } from '$lib/paraglide/runtime';
	import { Badge, Button, Select, Switch, Textarea, Toggle, ToggleGroup } from "@aipotluck/alpha-ds";
	import { useSettingsStore } from "$lib/chat/stores/settings";
	import { PERSONAL_INSTRUCTIONS_KEY } from "$lib/chat/utils/createConversation";
	import {
		activePreset,
		ANSWER_DEFAULTS,
		ANSWER_LANGUAGES,
		type AnswerLanguage,
		type AnswerPreferenceKey,
		type AnswerPreferences,
		EMOJIS,
		type Emojis,
		type Format,
		FORMATS,
		isDefault,
		type Length,
		LENGTHS,
		PRESET_NAMES,
		type PresetName,
		PRESETS,
		resolveAnswerPreferences,
		type Tone,
		TONES,
	} from "$lib/chat/answerPreferences";
	import { fromIso1, localLanguageName } from "$lib/chat/routing/languages";

	// Settings → Personalization. Replaces the per-model "Models" page: with Auto choosing the model,
	// instructions belong to the person, not to a model — they are stored once (customPrompts["*"])
	// and read by the server on every turn, so an edit reaches chats already open (turnPreferences.ts,
	// CUR-1443). The server always keeps Alpha's own persona first; these can only add context.
	const settings = useSettingsStore();
	// Layout data's `pastChatSearchEnabled` (signed in, past-chat-search flag on). (CUR-4576)
	const pastChatsOffered = $derived(page.data.pastChatSearchEnabled === true);
	// Shown to anyone agent mode is open to: auto mode is the default, and this is the way back to a card per step.
	const agentOffered = $derived(page.data.agentEnabled === true);

	// The structured answer settings (answerPreferences.ts). Each row shows the resolved
	// value, a Default badge while the row is unset, and a Reset that unsets it. Every change saves at
	// once through the store's serial lane (answerSaveLane.ts), so the pill and the badge answer before
	// the request does. CUR-3930 added the sixth row, how Alpha refers to itself. (CUR-3929)
	const prefs = $derived(resolveAnswerPreferences($settings));
	type RowKey = AnswerPreferenceKey;
	const unset = (key: RowKey) => isDefault($settings, key);
	const reset = (key: RowKey) => settings.setField(key, undefined);
	// Picking Alpha's default value unsets the row, as Reset does, so the row reads Default again.
	const orUnset = <K extends RowKey>(key: K, value: AnswerPreferences[K]): AnswerPreferences[K] | undefined =>
		value === ANSWER_DEFAULTS[key] ? undefined : value;

	const toneLabels: Record<Tone, () => string> = {
		plain: m.settings_answerTonePlain,
		neutral: m.settings_answerToneNeutral,
		formal: m.settings_answerToneFormal,
	};
	const lengthLabels: Record<Length, () => string> = {
		short: m.settings_answerLengthShort,
		normal: m.settings_answerLengthNormal,
		detailed: m.settings_answerLengthDetailed,
	};
	const formatLabels: Record<Format, () => string> = {
		auto: m.settings_answerFormatAuto,
		prose: m.settings_answerFormatProse,
		bullets: m.settings_answerFormatBullets,
	};
	const emojiLabels: Record<Emojis, () => string> = {
		never: m.settings_answerEmojisNever,
		helpful: m.settings_answerEmojisHelpful,
	};
	const presetLabels: Record<PresetName, () => string> = {
		plain: m.settings_answerPresetPlain,
		neutral: m.settings_answerPresetNeutral,
		formal: m.settings_answerPresetFormal,
		explanatory: m.settings_answerPresetExplanatory,
	};
	// The preset the rows match over PRESET_FIELDS, or custom. Picking one writes exactly those
	// fields in one request through the same lane, so it queues behind any write in flight and ahead
	// of any later one. Language, suggestions and the receipt are never touched. (CUR-549)
	const preset = $derived(activePreset(prefs));
	const pickPreset = (name: string) => settings.setFields(PRESETS[name as PresetName]);
	// The boolean `selfReferenceAsPerson` shown as two named choices, since "off" is not a
	// state a person would name; the honesty line under the label holds in both. (CUR-3930)
	const SELF_REFERENCE_OPTIONS = ["machine", "person"] as const;
	type SelfReference = (typeof SELF_REFERENCE_OPTIONS)[number];
	const selfReferenceLabels: Record<SelfReference, () => string> = {
		machine: m.settings_answerSelfReferenceMachine,
		person: m.settings_answerSelfReferencePerson,
	};
	const selfReference = $derived<SelfReference>(prefs.selfReferenceAsPerson ? "person" : "machine");
	const languageItems = $derived(
		ANSWER_LANGUAGES.map((code) => ({
			value: code,
			label: code === "auto" ? m.settings_answerLanguageAuto() : localLanguageName(fromIso1(code), getLocale()),
		}))
	);

	const saved = $derived($settings.customPrompts?.[PERSONAL_INSTRUCTIONS_KEY] ?? "");
	let draft = $state<string | undefined>(undefined);
	const value = $derived(draft ?? saved);
	const dirty = $derived(draft !== undefined && draft.trim() !== saved.trim());

	async function save() {
		if (!dirty) return;
		await settings.instantSet({
			customPrompts: { ...$settings.customPrompts, [PERSONAL_INSTRUCTIONS_KEY]: (draft ?? "").trim() }
		});
		draft = undefined;
	}
</script>

{#snippet rowHead(key: RowKey, label: string, help: string)}
	<div class="flex min-w-0 flex-col gap-0.5">
		<span class="flex items-center gap-2">
			<span id="answer-{key}-label" class="type-body text-fg-1">{label}</span>
			{#if unset(key)}
				<Badge data-answer-default={key}>{m.settings_answerDefault()}</Badge>
			{:else}
				<Button
					variant="link"
					size="sm"
					onclick={() => reset(key)}
					aria-label={m.settings_answerResetLabel({ label })}
					data-answer-reset={key}
				>
					{m.settings_answerReset()}
				</Button>
			{/if}
		</span>
		<span class="type-caption text-fg-3">{help}</span>
	</div>
{/snippet}

{#snippet choice(key: RowKey, label: string, help: string, current: string, options: [string, string][], onchange: (v: string) => void)}
	<div class="flex items-center justify-between gap-4 py-4" data-answer-row={key}>
		{@render rowHead(key, label, help)}
		<ToggleGroup
			value={[current]}
			onValueChange={(v: string[]) => v[0] && v[0] !== current && onchange(v[0])}
			aria-label={label}
		>
			{#each options as [v, l] (v)}<Toggle value={v}>{l}</Toggle>{/each}
		</ToggleGroup>
	</div>
{/snippet}

{#snippet onOff(key: RowKey, label: string, help: string, checked: boolean, onchange: (v: boolean) => void)}
	<div class="flex items-center justify-between gap-4 py-4" data-answer-row={key}>
		{@render rowHead(key, label, help)}
		<Switch.Root
			{checked}
			onCheckedChange={(v: boolean) => v !== checked && onchange(v)}
			aria-labelledby="answer-{key}-label"
		>
			<Switch.Thumb />
		</Switch.Root>
	</div>
{/snippet}

<div class="flex flex-col gap-10">
	<section class="flex flex-col gap-3" aria-labelledby="answer-heading">
		<div class="flex flex-col gap-1">
			<h2 id="answer-heading" class="type-label text-fg-1">{m.settings_answerTitle()}</h2>
			<p class="type-caption text-fg-2">{m.settings_answerHelp()}</p>
		</div>
		{#if $settings.answerSaveFailed}
			<p role="alert" class="type-caption text-accent-2-text" data-answer-error>{m.settings_answerSaveFailed()}</p>
		{/if}
		<div data-surface="2" class="flex flex-col divide-y divide-line-surface border border-line-2 bg-surface-2 px-4 rounded-card">
			<div class="flex flex-col gap-2 py-4" data-answer-row="preset" data-answer-preset={preset}>
				<div class="flex items-center justify-between gap-4">
					<span id="answer-preset-label" class="type-body text-fg-1">{m.settings_answerPreset()}</span>
					<ToggleGroup
						value={preset === "custom" ? [] : [preset]}
						onValueChange={(v: string[]) => v[0] && v[0] !== preset && pickPreset(v[0])}
						aria-label={m.settings_answerPreset()}
					>
						{#each PRESET_NAMES as name (name)}<Toggle value={name}>{presetLabels[name]()}</Toggle>{/each}
					</ToggleGroup>
				</div>
				<span class="type-caption text-fg-3" data-answer-preset-note>
					{preset === "custom" ? m.settings_answerPresetCustom() : m.settings_answerPresetHelp()}
				</span>
			</div>
			{@render choice(
				"tone",
				m.settings_answerTone(),
				m.settings_answerToneHelp(),
				prefs.tone,
				TONES.map((t) => [t, toneLabels[t]()]),
				(v) => settings.setField("tone", orUnset("tone", v as Tone))
			)}
			{@render choice(
				"answerLength",
				m.settings_answerLength(),
				m.settings_answerLengthHelp(),
				prefs.answerLength,
				LENGTHS.map((l) => [l, lengthLabels[l]()]),
				(v) => settings.setField("answerLength", orUnset("answerLength", v as Length))
			)}
			{@render onOff(
				"suggestions",
				m.settings_answerSuggestions(),
				m.settings_answerSuggestionsHelp(),
				prefs.suggestions,
				(v) => settings.setField("suggestions", orUnset("suggestions", v))
			)}
			<div class="flex items-center justify-between gap-4 py-4" data-answer-row="answerLanguage">
				{@render rowHead("answerLanguage", m.settings_answerLanguage(), m.settings_answerLanguageHelp())}
				<Select.Root
					value={prefs.answerLanguage}
					onValueChange={(v: string) => v && v !== prefs.answerLanguage && settings.setField("answerLanguage", orUnset("answerLanguage", v as AnswerLanguage))}
					items={languageItems}
				>
					<Select.Trigger aria-labelledby="answer-answerLanguage-label" class="min-w-48">
						<Select.Value />
						<Select.Icon />
					</Select.Trigger>
					<Select.Portal>
						<Select.Positioner align="end">
							<Select.Popup>
								{#each languageItems as item (item.value)}
									<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
								{/each}
							</Select.Popup>
						</Select.Positioner>
					</Select.Portal>
				</Select.Root>
			</div>
			{@render onOff(
				"plainLanguage",
				m.settings_answerPlainLanguage(),
				m.settings_answerPlainLanguageHelp(),
				prefs.plainLanguage,
				(v) => settings.setField("plainLanguage", orUnset("plainLanguage", v))
			)}
			{@render choice(
				"answerFormat",
				m.settings_answerFormat(),
				m.settings_answerFormatHelp(),
				prefs.answerFormat,
				FORMATS.map((f) => [f, formatLabels[f]()]),
				(v) => settings.setField("answerFormat", orUnset("answerFormat", v as Format))
			)}
			{@render choice(
				"emojis",
				m.settings_answerEmojis(),
				m.settings_answerEmojisHelp(),
				prefs.emojis,
				EMOJIS.map((e) => [e, emojiLabels[e]()]),
				(v) => settings.setField("emojis", orUnset("emojis", v as Emojis))
			)}
			{@render choice(
				"selfReferenceAsPerson",
				m.settings_answerSelfReference(),
				m.settings_answerSelfReferenceHelp(),
				selfReference,
				SELF_REFERENCE_OPTIONS.map((o) => [o, selfReferenceLabels[o]()]),
				(v) => settings.setField("selfReferenceAsPerson", orUnset("selfReferenceAsPerson", v === "person"))
			)}
			{@render onOff(
				"showServing",
				m.settings_answerShowServing(),
				m.settings_answerShowServingHelp(),
				prefs.showServing,
				(v) => settings.setField("showServing", orUnset("showServing", v))
			)}
		</div>
	</section>

	<section class="flex flex-col gap-3" aria-labelledby="instructions-heading">
		<div class="flex items-start justify-between gap-4">
			<div class="flex flex-col gap-1">
				<h2 id="instructions-heading" class="type-label text-fg-1">{m.settings_instructionsTitle()}</h2>
				<p class="type-caption text-fg-2">
					{m.settings_instructionsHelp()}
				</p>
			</div>
			<Button variant="secondary" size="sm" disabled={!dirty} onclick={save} data-save-instructions>{m.settings_save()}</Button>
		</div>
		<Textarea
			minRows={6}
			maxRows={16}
			value={value}
			oninput={(e: Event) => (draft = (e.currentTarget as HTMLTextAreaElement).value)}
			placeholder={m.settings_instructionsPlaceholder()}
			aria-labelledby="instructions-heading"
			data-instructions
		/>
	</section>

	<section class="flex flex-col gap-3" aria-labelledby="memory-heading">
		<div class="flex flex-col gap-1">
			<!-- Section headings read the same on every settings page: a label, then a caption (CUR-3954). -->
			<h2 id="memory-heading" class="flex items-center gap-2 type-label text-fg-1">
				{m.settings_memoryTitle()}
				{#if !pastChatsOffered}<Badge>{m.settings_comingSoon()}</Badge>{/if}
			</h2>
			<p class="type-caption text-fg-2">
				{pastChatsOffered ? m.settings_memoryHelpPastChats() : m.settings_memoryHelp()}
			</p>
		</div>
		<!-- Disabled, not decorative: a control that accepts a choice and ignores it is the thing
		     CUR-1060 removed. These say plainly that memory doesn't exist yet. -->
		<div data-surface="2" class="flex flex-col divide-y divide-line-surface border border-line-2 bg-surface-2 px-4 rounded-card">
			<!-- CUR-4576: past-chat search, the one memory control that works. Off by default; shown only
			     to a signed-in account with the past-chat-search flag on. -->
			{#if pastChatsOffered}
				<div class="flex items-center justify-between gap-4 py-4" data-testid="past-chats-search-row">
					<div class="flex flex-col gap-0.5">
						<span id="past-chats-search-label" class="type-body text-fg-1">{m.settings_pastChatsSearch()}</span>
						<span class="type-caption text-fg-3">{m.settings_pastChatsSearchHelp()}</span>
					</div>
					<Switch.Root
						aria-labelledby="past-chats-search-label"
						checked={$settings.searchPastChats === true}
						onCheckedChange={(v: boolean) => settings.update((s) => ({ ...s, searchPastChats: v }))}
					><Switch.Thumb /></Switch.Root>
				</div>
			{/if}
			<div class="flex items-center justify-between gap-4 py-4">
				<div class="flex flex-col gap-0.5">
					<span class="type-body text-fg-1">{m.settings_memoryRemember()}</span>
					<span class="type-caption text-fg-3">{m.settings_memoryRememberHelp()}</span>
				</div>
				<Switch.Root checked={false} disabled aria-label={m.settings_comingSoonLabel({ label: m.settings_memoryRemember() })}><Switch.Thumb /></Switch.Root>
			</div>
			<div class="flex items-center justify-between gap-4 py-4">
				<div class="flex flex-col gap-0.5">
					<span class="type-body text-fg-1">{m.settings_memoryWebSearch()}</span>
					<span class="type-caption text-fg-3">{m.settings_memoryWebSearchHelp()}</span>
				</div>
				<Switch.Root checked={false} disabled aria-label={m.settings_comingSoonLabel({ label: m.settings_memoryWebSearch() })}><Switch.Thumb /></Switch.Root>
			</div>
			<div class="flex items-center justify-between gap-4 py-4">
				<div class="flex flex-col gap-0.5">
					<span class="type-body text-fg-1">{m.settings_memoryDelete()}</span>
					<span class="type-caption text-fg-3">{m.settings_memoryDeleteHelp()}</span>
				</div>
				<Button variant="destructive" size="sm" disabled>{m.settings_delete()}</Button>
			</div>
		</div>
	</section>

	{#if agentOffered}
		<section class="flex flex-col gap-3" aria-labelledby="agent-heading">
			<div class="flex flex-col gap-1">
				<h2 id="agent-heading" class="type-label text-fg-1">{m.settings_agentTitle()}</h2>
				<p class="type-caption text-fg-2">{m.settings_agentHelp()}</p>
			</div>
			<div data-surface="2" class="flex flex-col border border-line-2 bg-surface-2 px-4 rounded-card">
				<div class="flex items-center justify-between gap-4 py-4" data-testid="agent-ask-every-step-row">
					<div class="flex flex-col gap-0.5">
						<span id="agent-ask-every-step-label" class="type-body text-fg-1">{m.settings_agentAskEveryStep()}</span>
						<span class="type-caption text-fg-3">{m.settings_agentAskEveryStepHelp()}</span>
					</div>
					<Switch.Root
						aria-labelledby="agent-ask-every-step-label"
						checked={$settings.agentAskEveryStep === true}
						onCheckedChange={(v: boolean) => settings.update((s) => ({ ...s, agentAskEveryStep: v }))}
					><Switch.Thumb /></Switch.Root>
				</div>
			</div>
		</section>
	{/if}
</div>
