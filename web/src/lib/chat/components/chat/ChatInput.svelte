<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { onMount, tick, untrack } from 'svelte';

	import { afterNavigate } from '$app/navigation';

	import RiAdd from '~icons/ri/add-line';
	import RiGlobe from '~icons/ri/globe-line';
	import RiVolumeUp from '~icons/ri/volume-up-line';
	import RiMic from '~icons/ri/mic-line';
	import RiDashboard3 from '~icons/ri/dashboard-3-line';
	import { webSearchMode, type WebSearchMode } from '$lib/chat/stores/webSearchMode';
	import { speakMode, type SpeakMode } from '$lib/chat/stores/speakMode';
	import { agentMode, type AgentMode } from '$lib/chat/stores/agentMode';
	import type { ReasoningEffort } from '$lib/chat/types/Settings';
	import RiRobot from '~icons/ri/robot-line';
	import RiLoader from '~icons/ri/loader-line';
	import RiAttachment from '~icons/ri/attachment-line';
	import { composerTools, mimeOffered, pickerAccept, refusedPasteMessage } from './composerTools';
	import { Composer, Favicon, Menu, Toggle, Tooltip } from '@aipotluck/alpha-ds';
	import { faviconSrc } from '$lib/favicon';
	import { compactFinishedLinks, draftSegments, LINK_MARK } from '$lib/chat/utils/composerLinks';

	import { isVirtualKeyboard } from '$lib/chat/utils/isVirtualKeyboard';
	import { requireAuthUser } from '$lib/chat/utils/auth';
	import { addAttachments, attachmentRefusal } from '$lib/chat/utils/addAttachments';
	import { fetchAttachmentRooms } from '$lib/chat/utils/myFilesHeadroom';
	import { convertImages, shrinkImages } from '$lib/chat/utils/shrinkImage';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import RiPlugLine from '~icons/ri/plug-line';
	import { orgs } from '$lib/chat/routing/catalog';
	import OrgMention from '$lib/chat/components/provenance/OrgMention.svelte';
	import { base } from '$lib/chat/paths';
	import { trackEvent } from '$lib/analytics';

	interface Props {
		files?: File[];
		mimeTypes?: string[];
		value?: string;
		placeholder?: string;
		loading?: boolean;
		disabled?: boolean;
		// tools removed
		// Shown under Attach files: what the chosen model cannot read (a text-only model and photos).
		attachNote?: string;
		// Another model here reads photos and could be picked, so a refused photo may name this one.
		photoModelPickable?: boolean;
		// A guest where sign-in is offered: Attach files asks them to sign in instead of opening the picker.
		onSignInToAttach?: () => void;
		// Per-model "Reasoning effort" override from settings (CUR-680). Shown only when the
		// model's own settings-page switch is on; the level itself lives here, in the footer,
		// per the settings page's own copy ("Show a Low / Medium / High selector in the chat
		// footer for this model"). Cycles like webSearchMode/speakMode/agentMode.
		reasoningEffortEnabled?: boolean;
		reasoningEffort?: ReasoningEffort;
		// Open-web search composer toggle. When the toggle
		// is shown, the user can ground a turn on Wikipedia + Firecrawl + OpenAlex. Currently
		// hidden (showWebSearch={false}): search is auto-triggered by the recency
		// heuristic in ChatWindow, not a manual control. The
		// "Searching…" spinner banner still renders during an auto-search.
		showWebSearch?: boolean;
		webSearchEnabled?: boolean;
		// Drives the "Searching…" label inside the dormant manual web-search button
		// (showWebSearch). Auto-search runs in the send path (conversation/[id] writeMessage),
		// under the answer's loading spinner, not in the composer.
		webSearching?: boolean;
		// Heuristic hint that the draft wants current info — nudges the globe so the
		// user notices the option. Never auto-enables; the user always decides.
		webSearchAffordance?: boolean;
		// Friendly served-model name for the in-composer indicator (non-interactive,
		// one model for the alpha) — e.g. "Apertus 70B".
		modelLabel?: string;
		/** The model picker (ChatComposerFrame's), placed left of dictate. Absent on read-only views. */
		modelPicker?: import('svelte').Snippet;
		// Dictation's entry point (CUR-198): the recorder, the transcribe route and the layout flag
		// sit behind this button. Gated on dictationEnabled(), its own flag, independent of
		// `multimodal`.
		transcriptionEnabled?: boolean;
		onstartrecording?: () => void;
		/** Why dictation can't work right now (CUR-3403): dims the button and replaces its hover text. */
		dictationBlocked?: string;
		children?: import('svelte').Snippet;
		/** The files attached to this draft, as the first thing in the box, above the text. */
		attachments?: import('svelte').Snippet;
		onPaste?: (e: ClipboardEvent) => void;
		/** URLs pasted into this draft: their site icon shows at once, before anything follows them. */
		pastedUrls?: ReadonlySet<string>;
		/** Links typed in full (a space after them), compacted in the draft like pasted ones. */
		onlinks?: (urls: string[]) => void;
		focused?: boolean;
		onsubmit?: () => void;
	}

	let {
		files = $bindable([]),
		mimeTypes = [],
		value = $bindable(''),
		placeholder = '',
		loading = false,
		disabled = false,

		reasoningEffortEnabled = false,
		reasoningEffort = $bindable('medium'),
		showWebSearch = false,
		webSearchEnabled = $bindable(false),
		webSearching = false,
		webSearchAffordance = false,
		modelLabel = '',
		attachNote,
		photoModelPickable = false,
		onSignInToAttach,
		modelPicker,
		transcriptionEnabled = false,
		onstartrecording,
		dictationBlocked,
		children,
		attachments,
		onPaste,
		pastedUrls = new Set<string>(),
		onlinks,
		focused = $bindable(false),
		onsubmit
	}: Props = $props();

	const onFileChange = async (e: Event) => {
		if (!e.target) return;
		const target = e.target as HTMLInputElement;
		// Back to the box now, not once the photo is ready: a large one takes seconds to prepare, and
		// whatever the person types meanwhile otherwise lands on nothing (CUR-3197). Before any wait,
		// too, since redrawing it holds the main thread and keys typed then reach the page body.
		void focusTextarea({ immediate: true });
		// An avif, bmp, tiff or HEIC this browser can open becomes a JPEG first (CUR-3073).
		const chosen = await convertImages(Array.from(target.files ?? []), mimeOffered(mimeTypes, 'image/jpeg'));
		// The dialog's own filter can be switched to "All files", so the picker refuses what the
		// composer doesn't offer, the way paste and drop do (CUR-3051).
		const selected = chosen.filter((file) => mimeOffered(mimeTypes, file.type));
		const refusedMessage = refusedPasteMessage(
			chosen.filter((file) => !selected.includes(file)),
			{
				imageInputEnabled: true,
				imageInputOnSignIn: false,
				signedIn: true,
				loginEnabled: false,
				imagesOffered: mimeTypes.some((m) => m.startsWith('image/')),
				modelName: modelLabel,
				photoModelPickable
			}
		);
		if (refusedMessage)
			attachmentRefusal.set({
				message: refusedMessage,
				fix:
					photoModelPickable &&
					chosen.some((file) => file.type.startsWith('image/') && !mimeOffered(mimeTypes, file.type))
						? 'photo-model'
						: undefined
			});
		target.value = '';
		if (selected.length === 0) return;
		const room = fetchAttachmentRooms();
		const ready = await shrinkImages(selected);
		const rooms = await room;
		files = addAttachments(files, ready, rooms);
		await tick();
		void focusTextarea();
	};

	let textareaElement: HTMLTextAreaElement | undefined = $state();
	// The Dictate hover text anchors to the whole composer, not the mic: at phone width the toolbar
	// wraps, and a tooltip just above the mic lay on the chip row (CUR-2720).
	let composerEl: HTMLDivElement | undefined = $state();
	let isCompositionOn = $state(false);
	let blurTimeout: ReturnType<typeof setTimeout> | null = $state(null);

	let fileInputEl: HTMLInputElement | undefined = $state();
	let isDropdownOpen = $state(false);

	// One picker for every type on offer: text always, photos when the model reads them, PDF and Word
	// where the server opens them (CUR-987). The dialog's own filter shows what can be chosen.
	function openFilePicker() {
		fileInputEl?.click();
	}

	const waitForAnimationFrame = () =>
		typeof requestAnimationFrame === 'function'
			? new Promise<void>((resolve) => {
					requestAnimationFrame(() => resolve());
				})
			: Promise.resolve();

	/** `immediate` tries focusing before the waits, which are only for a menu still closing. */
	async function focusTextarea({ immediate = false } = {}) {
		if (page.data.shared && page.data.loginEnabled && !page.data.user) {
			return;
		}
		if (!textareaElement || textareaElement.disabled || isVirtualKeyboard()) {
			return;
		}
		if (immediate) textareaElement.focus({ preventScroll: true });
		if (typeof document !== 'undefined' && document.activeElement === textareaElement) {
			return;
		}

		await tick();

		if (typeof requestAnimationFrame === 'function') {
			await waitForAnimationFrame();
			await waitForAnimationFrame();
		}

		if (!textareaElement || textareaElement.disabled || isVirtualKeyboard()) {
			return;
		}

		try {
			textareaElement.focus({ preventScroll: true });
		} catch {
			textareaElement.focus();
		}

		// Retry only when focus failed due to #app being inert (modal closing transition)
		if (
			typeof document !== 'undefined' &&
			document.activeElement !== textareaElement &&
			document.getElementById('app')?.hasAttribute('inert')
		) {
			setTimeout(() => {
				if (!textareaElement || textareaElement.disabled || isVirtualKeyboard()) return;
				if (document.activeElement === textareaElement) return;
				try {
					textareaElement.focus({ preventScroll: true });
				} catch {
					textareaElement.focus();
				}
			}, 350);
		}
	}

	// On-demand focus entry point so callers (e.g. the welcome overlay's "Start
	// chatting") can move the cursor into the composer after dismissing, mirroring
	// prod's focus of [data-testid="multimodal-input"].
	export function focusComposer() {
		void focusTextarea();
	}

	// Warm the shared backends (Coop + injection classifiers + the model lane) on arrival, on focus, AND
	// on input (any value change: typing, paste, IME, mobile, autofill; the strongest "about to
	// send" intent), so the cold-start overlaps the user's read/compose window and the first turn's gate +
	// generation are warm. Coop's scale-to-zero origin is the slow leg (~1–2.5s cold, and the gate blocks
	// the model), so firing the moment composing begins is the best chance to have it warm by send.
	// Fire-and-forget + client-throttled (the server is throttled per-instance too, so an input-rate call
	// is a cheap no-op most of the time); keepalive survives nav.
	//
	// The response body is drained (`.then((r) => r.text())`) even though nothing reads it — the route
	// returns 204 with an empty body regardless. Leaving a fetch's body stream completely unconsumed lets
	// Chromium cancel it once the Response object is eligible for cleanup, and that cancellation surfaces
	// to any CDP/Playwright network listener as `net::ERR_ABORTED` — AFTER the real response (204) was
	// already logged. With the body unread, requestfailed
	// net::ERR_ABORTED fires after the 204; read, there is no failure event. Without the drain, a
	// network listener such as the fuzz harness (scripts/fuzz/agent-loop.mjs) records a false network
	// failure on a warm ping that succeeded.
	let lastWarmPingAt = 0;
	// A link typed in full loses its scheme to LINK_MARK, as a pasted one does, so its icon sits against
	// the address; the caret stays where it was in the text.
	function compactTypedLinks() {
		const el = textareaElement;
		if (!el || isCompositionOn || !el.value.includes('.')) return;
		const compacted = compactFinishedLinks(el.value, el.selectionStart);
		if (!compacted.urls.length) return;
		onlinks?.(compacted.urls);
		el.value = compacted.text;
		value = compacted.text;
		el.setSelectionRange(compacted.caret, compacted.caret);
	}

	function pingWarm() {
		const now = Date.now();
		if (now - lastWarmPingAt < 20_000) return;
		lastWarmPingAt = now;
		void fetch(`${base}/api/warm`, { method: 'GET', keepalive: true })
			.then((r) => r.text())
			.catch(() => {});
	}

	// The composer's tools (Tools menu + chips) as data — gating and write-through live in
	// composerTools.ts and are tested there.
	const TOOL_ICONS = { webSearch: RiGlobe, agent: RiRobot, readAloud: RiVolumeUp, reasoning: RiDashboard3 };
	const tools = $derived(
		composerTools(
			{
				readAloudEnabled: !!page.data.readAloudEnabled,
				agentEnabled: !!page.data.agentEnabled,
				reasoningEffortEnabled
			},
			{
				webSearch: { get: () => $webSearchMode, set: (v) => webSearchMode.set(v as WebSearchMode) },
				agent: { get: () => $agentMode, set: (v) => agentMode.set(v as AgentMode) },
				readAloud: { get: () => $speakMode, set: (v) => setSpeak(v as SpeakMode) },
				reasoning: { get: () => reasoningEffort, set: (v) => (reasoningEffort = v as ReasoningEffort) }
			}
		)
	);

	function setSpeak(next: SpeakMode) {
		speakMode.set(next);
		if (next !== "off") {
			// Spec's example values are auto/always_on; the real store enum is auto/always — passing
			// the real value rather than inventing a mismatched string.
			trackEvent("tts_activated", { mode: next });
		}
	}

	onMount(() => {
		void focusTextarea();
		pingWarm();
	});

	afterNavigate(() => {
		void focusTextarea();
	});

	// The textarea is `disabled` while `loading` (a turn streaming) — every other focus call site
	// here is mount/navigation/file-picker/welcome-overlay, none for the end of a turn, so the
	// composer would be left unfocused (activeElement falls to <body>) the moment `loading` flips back
	// to false, forcing a re-click before every message. Same untrack() pattern
	// ChatWindow.svelte's stackWasOpen already uses for an open/close transition, so writing the
	// previous-value tracker doesn't also re-trigger this same effect.
	let wasLoading = false;
	$effect(() => {
		const isLoading = loading;
		untrack(() => {
			if (wasLoading && !isLoading) {
				void focusTextarea();
			}
			wasLoading = isLoading;
		});
	});

	function adjustTextareaHeight() {
		if (!textareaElement) {
			return;
		}

		textareaElement.style.height = 'auto';
		textareaElement.style.height = `${textareaElement.scrollHeight}px`;

		if (textareaElement.selectionStart === textareaElement.value.length) {
			textareaElement.scrollTop = textareaElement.scrollHeight;
		}
		syncMirrorScroll();
	}

	// A textarea can't hold an image, so links get their site icon from a layer behind it that draws
	// the same text in the same box. While that layer shows, the textarea's own glyphs are transparent
	// (its caret and selection stay), so what you read is the layer, line for line. Each link's
	// `https://` is drawn as space with the icon at its end, beside the host.
	let segments = $derived(draftSegments(value, pastedUrls));
	let mirrored = $derived(segments.some((s) => s.kind === 'link'));
	let mirrorElement: HTMLDivElement | undefined = $state();

	function syncMirrorScroll() {
		if (mirrorElement && textareaElement) mirrorElement.scrollTop = textareaElement.scrollTop;
	}

	$effect(() => {
		if (!textareaElement) return;
		void value;
		adjustTextareaHeight();
	});

	function handleKeydown(event: KeyboardEvent) {
		if (
			event.key === 'Enter' &&
			!event.shiftKey &&
			!isCompositionOn &&
			!isVirtualKeyboard() &&
			value.trim() !== ''
		) {
			event.preventDefault();
			tick();
			onsubmit?.();
		}
	}

	function handleFocus() {
		if (requireAuthUser()) {
			return;
		}
		if (blurTimeout) {
			clearTimeout(blurTimeout);
			blurTimeout = null;
		}
		focused = true;
		pingWarm();
	}

	function handleBlur() {
		if (!isVirtualKeyboard()) {
			focused = false;
			return;
		}

		if (blurTimeout) {
			clearTimeout(blurTimeout);
		}

		blurTimeout = setTimeout(() => {
			blurTimeout = null;
			focused = false;
		});
	}

	// The attach button shows wherever a file type is on offer. offeredMimeTypes offers none where the
	// server would refuse every upload (no scanner, or the `multimodal` flag shut for this visitor), so
	// the button never appears and then fails (CUR-2725). A text-only model still takes text files and
	// documents; it keeps the button, as a drop on the same composer works.
	let showFileUpload = $derived(mimeTypes.length > 0);
	// The tools row always renders — it carries the permanent Web-search on/off toggle (plus
	// optional file-upload / dormant force-search control / model label).
	// The leading `true` is the override; the disjunction records what
	// it would depend on otherwise.
	// eslint-disable-next-line no-constant-binary-expression
	let showToolsRow = $derived(true || showFileUpload || showWebSearch || !!modelLabel);
	function toggleWebSearch() {
		if (requireAuthUser()) return;
		webSearchEnabled = !webSearchEnabled;
	}

	// Search-offer banner (prod parity, Feature Lock §2: "the visitor should
	// understand WHY this feature is triggered"). When the draft looks recency-bound,
	// offer the explicit choice — ground on open sources, or answer from training.
	function offerSearch() {
		if (requireAuthUser()) return;
		webSearchEnabled = true;
		onsubmit?.();
	}
	function offerTraining() {
		if (requireAuthUser()) return;
		onsubmit?.();
	}

	// A tool's name mid-sentence: lowercased, except in German, where nouns keep their capital.
	const inSentence = (label: string) => (getLocale() === 'de' ? label : label.toLowerCase());
</script>

<div bind:this={composerEl} class="flex min-h-full flex-1 flex-col" onpaste={onPaste}>
	{#if attachments}<div class="px-2 pt-2">{@render attachments()}</div>{/if}
	{#if showWebSearch && webSearchAffordance}
		<div
			class="mx-2 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-sharp border border-[var(--ap-rule)] bg-[var(--ap-paper-2)]/60 px-3 py-2 font-mono text-[length:var(--ap-text-2)] text-[var(--ap-ink-2)]"
		>
			<RiGlobe class="size-3.5 shrink-0 text-[var(--ap-live-text)]" />
			<span>{m.product_currentInfo()}</span>
			<div class="ml-auto flex items-center gap-1.5">
				<button
					type="button"
					onclick={offerSearch}
					class="rounded-sharp bg-[var(--ap-ink)] px-2.5 py-1 text-[var(--ap-paper)] transition-opacity hover:opacity-85"
				>
					{m.product_searchSources()}
				</button>
				<button
					type="button"
					onclick={offerTraining}
					class="rounded-sharp border border-[var(--ap-rule)] px-2.5 py-1 text-[var(--ap-ink-2)] transition-colors hover:text-[var(--ap-ink)]"
				>
					{m.product_answerTraining()}
				</button>
			</div>
		</div>
	{/if}
	<!-- Locked (disabled) while a turn streams: we don't queue messages, so an editable field would
	     falsely imply you can compose/send a second turn mid-answer. On submit the draft is cleared
	     (ChatWindow handleSubmit sets draft="") and the field locks — together an honest "sent". -->
	<div class="relative">
		{#if mirrored}
			<!-- Segments are written with no whitespace between tags: this layer is pre-wrap, so any
			     would render and push it out of line with the textarea. -->
			<div
				bind:this={mirrorElement}
				aria-hidden="true"
				class="composer-mirror scrollbar-custom pointer-events-none absolute inset-0 overflow-x-hidden overflow-y-auto px-2.5 py-2.5 break-words whitespace-pre-wrap sm:px-3"
				class:text-[var(--ap-ink-3)]={disabled || loading}
				data-composer-mirror
			>{#each segments as segment, i (i)}{#if segment.kind === 'text'}{segment.text}{:else}<span class="composer-link" data-composer-link={segment.href}><span class="composer-scheme">{segment.scheme}{#if segment.scheme === LINK_MARK}<span class="absolute inset-y-0 left-0 right-0.5 flex items-center"><Favicon src={faviconSrc(segment.href)} size="md" class="max-w-full" /></span>{:else}<Favicon src={faviconSrc(segment.href)} size="md" class="absolute top-1/2 right-0.5 -translate-y-1/2" />{/if}</span><span class="composer-link-rest">{segment.rest}</span></span>{/if}{/each}&#8203;</div>
		{/if}
		<textarea
			rows="1"
			tabindex="0"
			inputmode="text"
			aria-label={m.product_messageAria()}
			data-chat-input
			class={[
				'scrollbar-custom relative block max-h-[4lh] w-full resize-none overflow-x-hidden overflow-y-auto border-0 bg-transparent px-2.5 py-2.5 outline-hidden focus:ring-0 focus-visible:ring-0 sm:px-3 md:max-h-[8lh]',
				// A locked composer's hint is drawn as dim hint text, never in the white that
				// reads as something already typed. (CUR-3400)
				disabled || loading ? 'text-fg-3 placeholder:text-fg-3' : 'dark:placeholder:text-white'
			]}
			class:composer-mirrored={mirrored}
			onscroll={syncMirrorScroll}
			bind:value
			bind:this={textareaElement}
			onkeydown={handleKeydown}
			oninput={() => {
				compactTypedLinks();
				pingWarm();
			}}
			oncompositionstart={() => (isCompositionOn = true)}
			oncompositionend={() => (isCompositionOn = false)}
			{placeholder}
			disabled={disabled || loading}
			onfocus={handleFocus}
			onblur={handleBlur}
			onbeforeinput={requireAuthUser}
		></textarea>
	</div>

	{#if showToolsRow}
		<!-- Composer toolbar: [+] attachments · [Tools] menu · chips for the tools that
		     are on (tap a chip to turn it off) · dictate on the right. The three-state modes live in the
		     Tools menu as radio groups, so the current value is always visible where it is changed —
		     which also settles CUR-1432 (a cycling control dismissing the label that showed its state).
		     The send/stop button is positioned by ChatWindow; `max-w` reserves its corner. -->
		<div class="flex max-w-[calc(100%-44px)] flex-wrap items-center gap-1.5 px-2 pt-1 pb-2">
			{#if showFileUpload}
				<input
					bind:this={fileInputEl}
					disabled={loading}
					class="absolute hidden size-0"
					aria-label={m.product_uploadFile()}
					type="file"
					multiple
					onchange={onFileChange}
					onclick={(e) => {
						if (requireAuthUser()) {
							e.preventDefault();
						}
					}}
					accept={pickerAccept(mimeTypes).join(',')}
				/>
			{/if}
			<!-- One [+] menu holds attaching files and every composer tool, each tool a flyout whose row
			     shows its current mode, so the value is visible where it is changed (CUR-1432). -->
			<Menu.Root
				bind:open={isDropdownOpen}
				onOpenChange={(open) => {
					if (open && requireAuthUser()) {
						isDropdownOpen = false;
						return;
					}
					isDropdownOpen = open;
				}}
			>
				<Menu.Trigger
					variant="ghost"
					size="icon-sm"
					disabled={loading}
					aria-label={m.product_addFilesAndTools({ tools: tools.map((tool) => inSentence(tool.label)).join(', ') })}
					title={showFileUpload || onSignInToAttach ? m.product_attachFiles() : m.product_tools()}
				>
					<RiAdd aria-hidden="true" />
					{#if webSearchAffordance && $webSearchMode === 'off'}
						<!-- The draft looks like it needs current info and web search is off. -->
						<span class="absolute top-1 right-1 size-1.5 bg-accent-1" aria-hidden="true"></span>
					{/if}
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Positioner side="top" align="start" sideOffset={8}>
						<!-- Closing the menu puts focus in the message box: left nowhere, focus would sit on a dying
						     popup div and the next message's keystrokes would be lost (CUR-3237). -->
						<Menu.Popup
							class="w-72"
							onCloseAutoFocus={(e) => {
								e.preventDefault();
								if (textareaElement && !textareaElement.disabled) textareaElement.focus();
							}}
						>
							{#if showFileUpload}
								<Menu.Item onSelect={() => openFilePicker()}>
									<RiAttachment aria-hidden="true" />
									<span class="flex flex-col">
										<span class="text-fg-1">{m.product_attachFiles()}</span>
										<!-- The link out to Hugging Face must not also choose the row and open the picker. Only
										     the mention stops the click: the caption's own words are the row, and a click on them
										     (the row's middle once a note adds a third line) opens the picker. -->
										<span class="type-caption text-fg-3"
											>{#each m.product_attachFilesWhere({ org: '{org}' }).split(/(\{org\})/).filter(Boolean) as part, i (i)}{#if part === '{org}'}<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions --><span
														onclick={(e) => e.stopPropagation()}
														onpointerup={(e) => e.stopPropagation()}
														onpointerdown={(e) => e.stopPropagation()}><OrgMention org={orgs.huggingface} tabindex={-1} /></span
													>{:else}{part}{/if}{/each}</span
										>
										{#if attachNote}<span class="type-caption text-fg-2" data-testid="attach-note">{attachNote}</span>{/if}
									</span>
								</Menu.Item>
								<Menu.Separator />
							{:else if onSignInToAttach}
								<!-- Guests cannot attach files: the row says so and leads to sign-in. -->
								<Menu.Item onSelect={() => onSignInToAttach()} data-testid="attach-sign-in">
									<RiAttachment aria-hidden="true" />
									<span class="flex flex-col">
										<span class="text-fg-1">{m.product_attachFiles()}</span>
										<span class="type-caption text-fg-3">{m.product_signInToAttach()}</span>
									</span>
								</Menu.Item>
								<Menu.Separator />
							{/if}
							{#each tools as tool (tool.id)}
								{@const ToolIcon = TOOL_ICONS[tool.id]}
								<Menu.SubmenuRoot>
									<Menu.SubmenuTrigger>
										<ToolIcon aria-hidden="true" />
										<span class="text-fg-1">{tool.label}</span>
										<span class="ml-auto type-caption text-fg-3">{tool.options.find((o) => o.value === tool.get())?.label}</span>
									</Menu.SubmenuTrigger>
									<Menu.Portal>
										<Menu.Positioner>
											<Menu.Popup class="w-72">
												<Menu.Group>
													<Menu.GroupLabel>{tool.label}</Menu.GroupLabel>
													<Menu.RadioGroup value={tool.get()} onValueChange={(v) => tool.set(v)}>
														{#each tool.options as option (option.value)}
															<Menu.RadioItem value={option.value} closeOnSelect={false}>
																<span class="flex flex-col">
																	<span class="text-fg-1">{option.label}</span>
																	{#if option.description}<span class="type-caption text-fg-3">{option.description}</span>{/if}
																</span>
															</Menu.RadioItem>
														{/each}
													</Menu.RadioGroup>
													{#if tool.id === 'webSearch' && $agentMode !== 'off' && $webSearchMode !== 'off'}
														<!-- CUR-657: an agent turn never reads searchContext; say so rather than promise a search. -->
														<p class="px-2 pb-1 type-caption text-fg-3">{m.product_agentNotApplied({ value: $agentMode === 'auto' ? m.product_auto() : m.product_on() })}</p>
													{/if}
												</Menu.Group>
											</Menu.Popup>
										</Menu.Positioner>
									</Menu.Portal>
								</Menu.SubmenuRoot>
							{/each}
							{#if (page.data as { mcpServersEnabled?: boolean }).mcpServersEnabled}
								<!-- CUR-4016: connected services, and adding one of your own, live in Settings → Connectors. -->
								<Menu.Separator />
								<Menu.Item onSelect={() => goto(`${base}/settings/connectors`)} data-testid="composer-connectors">
									<RiPlugLine aria-hidden="true" />
									<span class="text-fg-1">{m.product_connectors()}</span>
								</Menu.Item>
							{/if}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>

			<!-- Active tools as chips (enabled tools show beside the composer); web search
			     and agent show none, their mode reads on the + menu's row. -->
			{#if showWebSearch}
				<!-- Dormant per-turn "ground this answer" opt-in (showWebSearch is false today). -->
				<Toggle pressed={webSearchEnabled} onPressedChange={toggleWebSearch} disabled={loading} aria-label={m.product_searchCurrent()} title={m.product_groundSources()}>
					{#if webSearching}<RiLoader class="animate-spin" aria-hidden="true" /> {m.product_searching()}{:else}<RiGlobe aria-hidden="true" /> {m.product_openSearch()}{/if}
				</Toggle>
			{/if}
			{#each tools.filter((t) => t.showsChip) as tool (tool.id)}
				{@const ChipIcon = TOOL_ICONS[tool.id]}
				<!-- The chip names the tool and its mode, so Auto and Always read differently (CUR-3570). -->
				<Composer.Chip
					icon={ChipIcon}
					disabled={loading}
					dismissLabel={tool.restValue === 'off' ? m.product_turnOffTool({ tool: inSentence(tool.label) }) : m.product_resetTool({ tool: inSentence(tool.label), value: m.product_medium() })}
					ondismiss={() => tool.set(tool.restValue)}
				>
					{tool.chipLabel}
				</Composer.Chip>
			{/each}

			<!-- Right edge (left of the send button): model picker, then dictate. -->
			<div class="ml-auto flex min-w-0 items-center gap-0.5">
				{@render modelPicker?.()}
				{#if transcriptionEnabled}
					<!-- The hover text says which way the control works: it records you, it doesn't read aloud.
					     A native `title` is never shown on a phone and a recording cannot capture it (CUR-2363). -->
					<Tooltip.Root>
						<Tooltip.Trigger
							variant="ghost"
							size="icon-sm"
							onclick={() => onstartrecording?.()}
							disabled={loading || disabled}
							aria-disabled={dictationBlocked ? 'true' : undefined}
							class={dictationBlocked
								? 'ui-disabled:pointer-events-auto ui-disabled:cursor-not-allowed'
								: undefined}
							aria-label={m.product_dictate()}
						>
							<RiMic aria-hidden="true" />
						</Tooltip.Trigger>
						<Tooltip.Portal>
							<Tooltip.Positioner side="top" align="end"
								><Tooltip.Popup customAnchor={composerEl}
									>{dictationBlocked ?? m.product_dictateHelp()}</Tooltip.Popup
								></Tooltip.Positioner
							>
						</Tooltip.Portal>
					</Tooltip.Root>
				{/if}
			</div>
		</div>
	{/if}
	{@render children?.()}
</div>

<style>
	/* In the base layer so utility classes (font-mono, text-xs, prose) keep
	   winning over these element selectors, as they did before Tailwind v4 */
	@layer base {
		:global(pre),
		:global(textarea) {
			font-family: inherit;
			box-sizing: border-box;
			line-height: 1.5;
			font-size: 16px;
		}
	}

	/* The mirror draws the text, so it must lay out exactly as the textarea does. */
	.composer-mirror {
		font-family: inherit;
		box-sizing: border-box;
		line-height: 1.5;
		font-size: 16px;
	}
	.composer-mirrored {
		color: transparent;
		caret-color: var(--ds-fg-1);
	}
	/* Underline only what is drawn: a decoration on the whole link would run under the blank scheme. */
	.composer-link-rest {
		text-decoration: underline;
		text-decoration-color: var(--ds-line-3);
		text-underline-offset: 2px;
	}
	.composer-scheme {
		position: relative;
		color: transparent;
	}
</style>
