<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { messageTooLongMessage } from '$lib/chat/utils/messageTooLong';
	import type { Message, MessageFile } from '$lib/chat/types/Message';
	import { isRecencyQueryDenoised } from '$lib/chat/search/recency';
	import { prefetchMarkdownAssets } from '$lib/chat/utils/marked';
	import { onMount, tick, type Snippet } from 'svelte';

	import ArtifactPanel from './ArtifactPanel.svelte';
	import { collectArtifacts } from '$lib/chat/utils/artifacts';
	import { setArtifactsContext } from '$lib/chat/utils/artifactsContext';
	import { artifactPanel } from '$lib/chat/stores/artifactPanel.svelte';

	import RiArrowRightS from '~icons/ri/arrow-right-s-line';
	import RiArrowUpLine from '~icons/ri/arrow-up-line';
	import RiStopFill from '~icons/ri/stop-fill';
	import { Attachment, Button, ComposerAccessory, Menu, ThreadHeader, EmptyStateSuggestion, getAppShell, useCompact, useToastManager } from '@aipotluck/alpha-ds';
	import RiImageLine from '~icons/ri/image-line';
	import RiAttachmentLine from '~icons/ri/attachment-line';
	import RiArrowDownSLine from '~icons/ri/arrow-down-s-line';
	import RiDownloadLine from '~icons/ri/download-line';
	import RiPencilLine from '~icons/ri/pencil-line';
	import RiDeleteBinFill from '~icons/ri/delete-bin-fill';
	import DeleteConversationModal from '$lib/chat/components/DeleteConversationModal.svelte';
	import RenameConversationDialog from '$lib/chat/components/RenameConversationDialog.svelte';
	import { getContext } from 'svelte';
	import { on } from 'svelte/events';

	import ChatComposerFrame from '$lib/chat/components/provenance/ChatComposerFrame.svelte';
	import ChatInput from './ChatInput.svelte';
	import {
		mimeOffered,
		offeredMimeTypes,
		photosOnSignIn,
		PHOTO_TYPES_THAT_ATTACH,
		photoTypesHint,
		refusedPasteMessage
	} from './composerTools';
	import { fileTypeLabel } from '$lib/chat/utils/fileTypeLabel';
	import { AUTO, modelChoice, modelPickRequest } from '$lib/chat/routing/choice';
	import { catalog, catalogByGatewayId, servedKey } from '$lib/chat/routing/catalog';
	import { nextTurnModel } from '$lib/chat/routing/state';
	import { goto } from '$app/navigation';
	import WelcomeModal from '$lib/chat/components/WelcomeModal.svelte';
	import GuidedTour from '$lib/chat/components/GuidedTour.svelte';
	import { tour } from '$lib/chat/tour/tour.svelte';
	import { wipedThisSession } from '$lib/chat/stores/deleteAll';
	import AiDisclosureBanner from '$lib/chat/components/AiDisclosureBanner.svelte';
	import ContributeDialog from './ContributeDialog.svelte';
	import WeakSpotsModal from './WeakSpotsModal.svelte';
	import { stackOpen } from '$lib/chat/stores/stack';
	import { downloadConversationMarkdown } from '$lib/chat/utils/exportConversation';
	import VoiceRecorder from './VoiceRecorder.svelte';
	import type { Model } from '$lib/chat/types/Model';
	import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
	import type { ReasoningEffort } from '$lib/chat/types/Settings';
	import FileDropzone from './FileDropzone.svelte';
	import file2base64 from '$lib/chat/utils/file2base64';
	import { addAttachments, attachmentRefusal, attachmentWarning } from '$lib/chat/utils/addAttachments';
	import { fetchAttachmentRooms } from '$lib/chat/utils/myFilesHeadroom';
	import {
		convertImages,
		shrinkImages,
		preparingPhotos,
		attachmentsPending,
		photosReady
	} from '$lib/chat/utils/shrinkImage';
	import { get } from 'svelte/store';
	import { speakMode } from '$lib/chat/stores/speakMode';
	import { primeAudioForAutoplay } from '$lib/chat/stores/audioPlayback';
	import {
		VOICE_RECORDING_MAX_BYTES,
		voiceRecordingTooLargeMessage
	} from '$lib/chat/constants/uploadLimits';
	import { base } from '$lib/chat/paths';
	import { resolveModelIdentity } from '$lib/chat/identity';
	import ChatMessage from './ChatMessage.svelte';
	import ConnectionStatus from './ConnectionStatus.svelte';
	import ScrollToBottomBtn from '../ScrollToBottomBtn.svelte';
	import ChatBackdrop from '../ChatBackdrop.svelte';
	import { browser } from '$app/environment';
	import { snapScrollToBottom } from '$lib/chat/actions/snapScrollToBottom';
	import SystemPromptModal from '../SystemPromptModal.svelte';
	import ChatIntroduction from './ChatIntroduction.svelte';
	import GuestRetentionNotice from './GuestRetentionNotice.svelte';
	import UploadedFile from './UploadedFile.svelte';
	import { compactPastedLinks, expandLinks } from '$lib/chat/utils/composerLinks';
	import { useSettingsStore } from '$lib/chat/stores/settings';
	import { welcomeReplay } from '$lib/chat/stores/welcomeReplay.svelte';
	import { error, errorHeld, isRateLimitMessage, sendHeldUntil } from '$lib/chat/stores/errors';
	import ModelSwitch from './ModelSwitch.svelte';
	import SessionFootprint from '$lib/chat/components/SessionFootprint.svelte';
	import { routerExamples } from '$lib/chat/constants/routerExamples';
	import type { RouterFollowUp, RouterExample } from '$lib/chat/constants/routerExamples';
	import { gapForPrompt, webSearchGapFor } from '$lib/chat/constants/starterGaps';
	import FeatureAnnouncementToast from '../FeatureAnnouncementToast.svelte';
	import { getActiveAnnouncement } from '$lib/chat/utils/featureAnnouncements';
	import { usePublicConfig } from '$lib/chat/utils/PublicConfig.svelte';
	import { pendingChatInput } from '$lib/chat/stores/pendingChatInput';
	import { refusedEdit } from '$lib/chat/stores/refusedEdit';
	import RiSparkling from '~icons/ri/sparkling-line';

	import { fade } from 'svelte/transition';

	import { isVirtualKeyboard } from '$lib/chat/utils/isVirtualKeyboard';
	import { requireAuthUser } from '$lib/chat/utils/auth';
	import { tap, error as hapticError } from '$lib/chat/utils/haptics';
	import { chromeCopy } from "$lib/chat/chromeCopy";
	import { page } from '$app/state';
	import { trackEvent } from '$lib/analytics';

	interface Props {
		messages?: Message[];
		messagesAlternatives?: Message['id'][][];
		loading?: boolean;
		pending?: boolean;
		shared?: boolean;
		/** The former workspace a read-only chat was in; it replaces the composer with why. (CUR-3040) */
		formerWorkspace?: string | null;
		currentModel: Model;
		models: Model[];
		preprompt?: string | undefined;
		files?: File[];
		onmessage?: (content: string) => void;
		onstop?: () => void;
		onretry?: (payload: { id: Message['id']; content?: string }) => void;
		onshowAlternateMsg?: (payload: { id: Message['id'] }) => void;
		draft?: string;
		embeddedDemo?: boolean;
		onDemoForgetEverything?: () => void;
		/** Demo only: where a click on an app-only destination is reported. */
		onEmbeddedNavigate?: (intent?: EmbeddedIntent) => void;
	}

	// The open conversation's title, provided by ChatShell (falls back when mounted elsewhere).
	const threadTitle = getContext<
		| { title: string; deleteCurrent?: () => void; renameCurrent?: (title: string) => void }
		| undefined
	>('alpha:thread-title') ?? { title: '' };
	let deleteThreadOpen = $state(false);
	let renameThreadOpen = $state(false);

	let {
		messages = [],
		messagesAlternatives = [],
		loading = false,
		pending = false,
		shared = false,
		formerWorkspace = null,
		currentModel,
		models,
		preprompt = undefined,
		files = $bindable([]),
		draft = $bindable(''),
		onmessage,
		onstop,
		onretry,
		onshowAlternateMsg,
		embeddedDemo = false,
		onDemoForgetEverything,
		onEmbeddedNavigate
	}: Props = $props();

	let isReadOnly = $derived(!models.some((model) => model.id === currentModel.id));

	// Friendly model name for the in-composer indicator — DERIVED from the served id
	// (never hardcoded) and the same source as the provenance badge, so they can't drift.
	let modelLabel = $derived(resolveModelIdentity(currentModel.id).short);

	// Export the current conversation as a Markdown file. Fully client-side (nothing leaves
	// the browser); title derived from the first user turn for a meaningful filename. The
	// serializer excludes the system prompt/persona — see exportConversation.ts.
	// Wired to the thread header's title menu ("Export as Markdown") — the home for
	// conversation-level actions.
	const exportChat = () => {
		const firstUser = messages.find((m) => m.from === 'user')?.content?.trim();
		const title = firstUser ? firstUser.split(/\s+/).slice(0, 8).join(' ') : undefined;
		downloadConversationMarkdown({ title, model: modelLabel, messages });
	};

	// XRAY lives in the composer: an X-ray pill beside "Where it goes" opens an X-ray panel at the composer's
	// width (ChatComposerFrame). Every other entry point (an answer's "How this was made", the welcome
	// CTA) sets the `stackOpen` store, which that panel follows.

	const publicConfig = usePublicConfig();

	// Feature announcement toast: home screen only, gone as soon as a chat starts.
	let featureAnnouncement = $derived(
		getActiveAnnouncement(publicConfig.PUBLIC_FEATURE_ANNOUNCEMENTS)
	);
	let showFeatureAnnouncement = $derived(page.route.id === '/' && !messages.length && !loading);

	// Artifacts: fold <artifact> operations from the visible message path into a
	// versioned registry, shared with the inline cards and the side panel.
	// Only the message currently receiving tokens can have a streaming artifact;
	// unclosed tags anywhere else are interrupted generations, not live ones.
	let artifactRegistry = $derived(
		collectArtifacts(messages, loading ? messages.at(-1)?.id : undefined)
	);
	setArtifactsContext({
		get registry() {
			return artifactRegistry;
		},
		panel: artifactPanel
	});

	// Auto-open the panel when a new artifact version starts streaming in
	// (once per version, so closing it mid-stream sticks).
	$effect(() => {
		const streaming = artifactRegistry.streaming;
		if (!streaming || !loading) return;
		artifactPanel.maybeAutoOpen(streaming.identifier, streaming.version);
	});

	let editMsdgId: Message['id'] | null = $state(null);
	let pastedLongContent = $state(false);
	// URLs pasted into this draft: their icon shows at once, where a typed one waits for a space.
	// Cleared on send, not when the draft is empty: a paste event fires before its text reaches the
	// draft, so an "empty draft" reset would wipe the URL the moment it was pasted into an empty composer.
	let pastedUrls = $state(new Set<string>());

	// Voice recording state
	let isRecording = $state(false);
	// After the browser can't record or the microphone is refused, the Dictate button
	// dims and its hover text says why, rather than looking live beside a toast saying it isn't.
	// A recording that goes through clears it, so allowing the microphone and pressing again works. (CUR-3403)
	let dictationBlocked = $state<string | undefined>();
	let isTranscribing = $state(false);
	let isTouchDevice = $derived(browser && navigator.maxTouchPoints > 0);

	// Open-web search. This is not
	// a manual composer toggle: the system decides when a turn needs current open-web
	// grounding. The decision AND the search run on the SEND path, AFTER the user's
	// message is on screen (conversation/[id] writeMessage → resolveSearchContext in
	// $lib/chat/search/resolveSearch) — so the message renders instantly instead of waiting
	// on the classify+search round-trip, which would leave a multi-second gap where
	// nothing appears. The manual globe toggle is hidden (showWebSearch={false} below);
	// webSearchEnabled is retained dormant so the control can be re-exposed without rewiring.
	let webSearchEnabled = $state(false);
	let draftLooksRecent = $derived(isRecencyQueryDenoised(draft));
	// Send looked ready while the draft was over the length cap, so a person had no cue that
	// pressing it would only be refused. It now dims like a disabled control but stays clickable
	// (aria-disabled, not disabled), so a click still lands on the refusal that says how much to cut. (CUR-2703)
	let draftOverLimit = $derived.by(() => {
		const limit = page.data.messageLengthLimit;
		return typeof limit === 'number' && limit > 0 && draft.length > limit;
	});

	// The FIRST web-grounded answer in this conversation — the only one that auto-surfaces the
	// always-true "no open Google-scale index" gap (WEB_SEARCH_GAP). Emphasize the web-search
	// component the first time it activates, then go quiet (later searches show no gap). A
	// curated starter gap still takes precedence where one exists.
	// `void loading` forces a recompute when a turn FINISHES (loading true→false): the streamed
	// message's webSearch is set mid-turn but an in-place mutation doesn't always retrigger this
	// `.find()`; recomputing on the loading edge (exactly when the gap's `!loading` gate opens)
	// picks up the just-set sources so the CTA appears live, not only after a reload.
	let firstWebGroundedId = $derived.by(() => {
		void loading;
		return messages.find((m) => m.from === 'assistant' && (m.webSearch?.sources?.length ?? 0) > 0)
			?.id;
	});

	// Highlight-to-reply: drop a selection from an answer into the composer as a Markdown quote,
	// then focus the input so the reader's next message is scoped to the quoted bit. Appends to
	// any existing draft rather than clobbering it.
	function quoteToComposer(text: string) {
		const quoted = text
			.split('\n')
			.map((l) => `> ${l}`)
			.join('\n');
		draft = draft.trim() ? `${draft.trim()}\n\n${quoted}\n\n` : `${quoted}\n\n`;
		tick().then(() => {
			// A stable hook keeps quote-to-composer working in every interface language.
			const ta = document.querySelector<HTMLTextAreaElement>(
				'textarea[data-chat-input]'
			);
			ta?.focus();
			ta?.setSelectionRange(ta.value.length, ta.value.length);
		});
	}

	// Warm KaTeX + highlight.js during idle. They're dynamically imported (kept OUT of the eager
	// bundle so first hydration is fast — see $lib/chat/utils/marked), but prefetching them in the
	// background here means they're ready before the first answer with math/code arrives, so the
	// readable plain/raw fallback is almost never seen. requestIdleCallback yields to the browser;
	// Safari < 17 lacks it, so fall back to a timeout.

	onMount(() => {

		const schedule =
			typeof window !== 'undefined' && 'requestIdleCallback' in window
				? (cb: () => void) => window.requestIdleCallback(cb)
				: (cb: () => void) => setTimeout(cb, 1500);
		schedule(() => prefetchMarkdownAssets());
	});

	// Set right before triggerPrompt() calls handleSubmit(), so the send below can tell a
	// starter/router-example send apart from a manually typed one (both funnel through here).
	let sentViaStarterPrompt = false;


	// While our own message limit's window runs, Send is held and the composer counts it
	// down. A press inside the window is refused and recorded, so it would only push the window out. (CUR-3216)
	let heldNow = $state(Date.now());
	const heldSeconds = $derived(
		$sendHeldUntil ? Math.max(0, Math.ceil(($sendHeldUntil - heldNow) / 1000)) : 0
	);
	$effect(() => {
		const until = $sendHeldUntil;
		if (!until) return;
		heldNow = Date.now();
		const timer = setInterval(() => {
			heldNow = Date.now();
			if (heldNow < until) return;
			sendHeldUntil.set(undefined);
			// The refusal's own toast is moot once the wait is over.
			if (get(errorHeld) && isRateLimitMessage(get(error))) {
				error.set(undefined);
				errorHeld.set(false);
			}
		}, 250);
		return () => clearInterval(timer);
	});

	let waitingForPhotos = false;
	const handleSubmit = async () => {
		// Guard on the trimmed draft, not just `!draft`: a whitespace-only draft ("   \n") is
		// truthy, so a bare `!draft` let the send button submit blank turns (Enter already trims).
		if (requireAuthUser() || loading || !draft.trim() || heldSeconds > 0) return;
		// Still inside the tap, before any await, so iOS lets the answer's read-aloud play later. (CUR-4666)
		if (page.data.readAloudEnabled && get(speakMode) !== 'off') primeAudioForAutoplay();
		attachmentRefusal.set(undefined);
		// A photo chosen a moment ago may still be shrinking or waiting on My files' headroom, and it
		// reaches `files` only when both end. Sending now would send the text without it, so wait; a
		// second Enter meanwhile is the same send (CUR-3197).
		if (attachmentsPending()) {
			if (waitingForPhotos) return;
			waitingForPhotos = true;
			try {
				// Converting and shrinking count separately, so the count can touch 0 between them.
				while (attachmentsPending()) {
					await photosReady();
					await tick();
				}
			} finally {
				waitingForPhotos = false;
			}
			if (loading || !draft.trim()) return;
		}
		// Refuse an over-long message here, with the server's own words, rather than send it.
		// Sending would render it as a user bubble under "The model is working…" until the 400 arrived and
		// rolled it back into the composer. The draft is left in place, and the next send clears the
		// held reason (writeMessage). parseRequest still enforces the cap for any other client. (CUR-1921)
		const limit = page.data.messageLengthLimit;
		if (typeof limit === 'number' && limit > 0 && draft.length > limit) {
			error.set(messageTooLongMessage(draft.length, limit));
			errorHeld.set(true);
			return;
		}
		tap();
		const text = expandLinks(draft, pastedUrls);
		draft = '';
		pastedUrls = new Set();
		trackEvent('message_sent', {
			turn_number: routerUserMessages.length + 1,
			used_starter_prompt: sentViaStarterPrompt,
			logged_in: !!page.data.user
		});
		sentViaStarterPrompt = false;
		// Hand off immediately: the parent renders the user's message + a pending answer at
		// once, then resolves open-web grounding with a calm status ON that answer (no
		// composer-blocking spinner, no dead gap before anything shows). Grounding is resolved
		// parent-side because it must survive the home→/conversation/[id] navigation, whose
		// history state is JSON-only (a Promise can't cross it).
		onmessage?.(text);
	};

	let lastTarget: EventTarget | null = null;

	let onDrag = $state(false);

	// Only a drag that carries files opens the dropzone; dragging selected text within the page does not.
	const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') === true;
	const onDragEnter = (e: DragEvent) => {
		if (!carriesFiles(e)) return;
		lastTarget = e.target;
		onDrag = true;
	};
	const onDragLeave = (e: DragEvent) => {
		if (e.target === lastTarget) {
			onDrag = false;
		}
	};

	async function onDrop(e: DragEvent) {
		// Always: a file let go anywhere on the page must never open in place of the chat.
		e.preventDefault();
		onDrag = false;
		if (!dropEnabled || !carriesFiles(e) || requireAuthUser()) return;
		if (signInToAttach) return askSignInToAttach();
		// Read before any await: the browser empties the list once the handler yields.
		const dropped = Array.from(e.dataTransfer?.files ?? []);
		if (dropped.length === 0) return;
		// A drop adds to what is already attached, as a paste or the picker does (CUR-3235).
		// An avif, bmp, tiff or HEIC this browser can open becomes a JPEG first (CUR-3073).
		const incoming = await convertImages(dropped, mimeOffered(activeMimeTypes, 'image/jpeg'));
		const refused = incoming.find((file) => !mimeOffered(activeMimeTypes, file.type));
		if (refused) {
			// Named in words, never as raw MIME types. (CUR-2839)
			const label = fileTypeLabel(refused.type, refused.name);
			const photo = photoTypesHint(refused, mimeOffered(activeMimeTypes, 'image/jpeg'));
			attachmentRefusal.set({
				message: `This file type can't be attached here: ${label}.${photo ? ` ${PHOTO_TYPES_THAT_ATTACH}` : ''}`
			});
			return;
		}
		const room = fetchAttachmentRooms();
		const ready = await shrinkImages(incoming);
		const rooms = await room;
		files = addAttachments(files, ready, rooms);
		setTimeout(() => chatInputRef?.focusComposer(), 0);
	}

	const onPaste = async (e: ClipboardEvent) => {
		const textContent = e.clipboardData?.getData('text');

		// Long text always becomes an attachment; the "Paste text directly" switch was retired.
		if (textContent && textContent.length >= 3984) {
			e.preventDefault();
			pastedLongContent = true;
			setTimeout(() => {
				pastedLongContent = false;
			}, 1000);
			const pastedFile = new File([textContent], 'Pasted Content', {
				type: 'application/vnd.chatui.clipboard'
			});

			files = [...files, pastedFile];
		} else if (textContent && e.clipboardData?.files.length === 0) {
			// A pasted link goes in with its scheme as one narrow mark, so its site icon sits right
			// against the address; the scheme comes back on send (composerLinks).
			const compacted = compactPastedLinks(textContent);
			if (compacted.urls.length) {
				pastedUrls = new Set([...pastedUrls, ...compacted.urls]);
				const field = e.target instanceof HTMLTextAreaElement ? e.target : undefined;
				if (field) {
					e.preventDefault();
					// insertText keeps the paste on the field's undo stack and fires input for bind:value.
					if (!document.execCommand('insertText', false, compacted.text)) {
						field.setRangeText(compacted.text, field.selectionStart, field.selectionEnd, 'end');
						field.dispatchEvent(new Event('input', { bubbles: true }));
					}
				}
			}
		}

		if (!e.clipboardData) {
			return;
		}

		// paste of files
		const clipboardFiles = Array.from(e.clipboardData.files);
		if (clipboardFiles.length !== 0 && signInToAttach) {
			e.preventDefault();
			askSignInToAttach();
			return;
		}
		if (clipboardFiles.length !== 0) {
			e.preventDefault();
			// An avif, bmp, tiff or HEIC this browser can open becomes a JPEG first (CUR-3073).
			const pastedFiles = await convertImages(clipboardFiles, mimeOffered(activeMimeTypes, 'image/jpeg'));

			const filteredFiles = pastedFiles.filter((file) => mimeOffered(activeMimeTypes, file.type));

			// A refused file gets a reason, the way a refused drop does (CUR-2949).
			const refused = pastedFiles.filter((file) => !filteredFiles.includes(file));
			const signedIn = Boolean(page.data.user);
			const imageInputEnabled = page.data.imageInputEnabled === true;
			const loginEnabled = page.data.loginEnabled === true;
			// Whether signing in would help is asked only now, for a guest whose photo was refused. (CUR-3015)
			const askSignIn =
				!signedIn && loginEnabled && !imageInputEnabled && refused.some((file) => file.type.startsWith('image/'));
			// Not awaited: the accepted files below must not wait on that answer.
			void (askSignIn ? photosOnSignIn(`${base}/api/sign-in-hint`) : Promise.resolve(false)).then(
				(imageInputOnSignIn) => {
					const refusedMessage = refusedPasteMessage(refused, {
						imageInputEnabled,
						imageInputOnSignIn,
						signedIn,
						loginEnabled,
						imagesOffered: activeMimeTypes.some((m) => m.startsWith('image/')),
						modelName: nextModelLabel,
						photoModelPickable
					});
					if (refusedMessage)
						attachmentRefusal.set({
							message: refusedMessage,
							fix:
								refused.some((file) => file.type.startsWith('image/')) && imageInputEnabled && photoModelPickable
									? 'photo-model'
									: undefined
						});
				}
			);

			const room = fetchAttachmentRooms();
			const ready = await shrinkImages(filteredFiles);
			const rooms = await room;
			files = addAttachments(files, ready, rooms);
		}
	};

	// The near-limit line belongs to the files on the composer; once they are sent or
	// removed it no longer describes anything. (CUR-3235)
	$effect(() => {
		if (files.length === 0) attachmentWarning.set(undefined);
	});

	let lastMessage = $derived(browser && (messages.at(-1) as Message));
	let showPendingPlaceholder = $derived(
		pending &&
			!(lastMessage && lastMessage.from === 'assistant' && (lastMessage.content ?? '').length === 0)
	);
	let streamingAssistantMessage = $derived(
		(() => {
			for (let i = messages.length - 1; i >= 0; i -= 1) {
				const candidate = messages[i];
				if (candidate.from === 'assistant') {
					return candidate;
				}
			}
			return undefined;
		})()
	);
	// The empty composer speaks the language the browser asks for, like the live status line. (CUR-1575)
	const composerPlaceholder = $derived(chromeCopy(page.data.uiLang).placeholder);
	let lastIsError = $derived(
		!loading &&
			(streamingAssistantMessage?.updates?.findIndex(
				(u) => u.type === 'status' && u.status === 'error'
			) ?? -1) !== -1
	);

	let sources = $derived(
		files?.map<Promise<MessageFile>>((file) =>
			file2base64(file).then((value) => ({
				type: 'base64',
				value,
				mime: file.type,
				name: file.name
			}))
		)
	);

	let chatContainer: HTMLElement | undefined = $state();
	// Bound out of ScrollToBottomBtn: the fade strip covers the text under the button while it shows.
	let scrollButtonVisible = $state(false);

	// Force scroll to bottom when user sends a new message or switches conversation
	let prevMessageCount = $state(0);
	// svelte-ignore state_referenced_locally
	let prevFirstMessageId = $state(messages.at(0)?.id);
	let forceReattach = $state(0);
	let scrollBehavior: 'auto' | 'instant' | 'smooth' = $state('instant');
	$effect(() => {
		const firstMessageId = messages.at(0)?.id;

		// Conversation switch: first message ID changed
		if (firstMessageId !== prevFirstMessageId) {
			prevFirstMessageId = firstMessageId;
			forceReattach++;
			// A "switch" that is actually the user sending the FIRST message of a NEW conversation (the
			// last message is the empty assistant we just added) must top-anchor like any other turn —
			// otherwise a long first response follows the stream to the bottom. A genuine conversation LOAD instead scrolls to the bottom of history with no spacer.
			const last = messages.at(-1);
			const secondLast = messages.at(-2);
			const firstUserSend =
				secondLast?.from === 'user' && last?.from === 'assistant' && last?.content === '';
			scrollBehavior = firstUserSend ? 'smooth' : 'instant';
			spacerActive = firstUserSend ? spacerActive + 1 : 0;
			spacerHeight = MIN_SPACER_PX;
			prevMessageCount = messages.length;
			artifactPanel.reset();
			return;
		}

		// New user message: user message + empty assistant message added together
		if (messages.length > prevMessageCount) {
			const last = messages.at(-1);
			const secondLast = messages.at(-2);
			const userJustSentMessage =
				messages.length === prevMessageCount + 2 &&
				secondLast?.from === 'user' &&
				last?.from === 'assistant' &&
				last?.content === '';

			if (userJustSentMessage) {
				scrollBehavior = 'smooth';
				forceReattach++;
				// Top-anchor EVERY user turn, including the first: the spacer + the followBottom gate keep
				// the new message pinned to the top and stop chasing a long response to the bottom. (The
				// first message of a NEW conversation is handled in the switch branch above.)
				spacerActive = spacerActive + 1;
			}
		}
		prevMessageCount = messages.length;
	});

	// Shared conversations containing artifacts usually exist to show one off:
	// open the most recent artifact on load, on its code tab, so its script runs
	// only once the viewer picks Preview (CUR-3187). Desktop only, since on mobile the
	// panel is a fullscreen overlay that would hide the conversation entirely.
	// Declared after the conversation-switch effect so its reset() can never
	// close the panel after this opens it within the same flush.
	let autoOpenedSharedArtifact = false;
	$effect(() => {
		if (autoOpenedSharedArtifact || !shared) return;
		const latest = [...artifactRegistry.artifacts.values()].at(-1);
		if (!latest) return;
		autoOpenedSharedArtifact = true;
		if (!window.matchMedia('(min-width: 768px)').matches) return;
		artifactPanel.openArtifact(latest.identifier, null, "code");
	});

	// Dynamic bottom spacer for ChatGPT-style scroll (new message appears near top of viewport)
	const MIN_SPACER_PX = 208; // equivalent to pb-52
	const SPACER_TOP_OFFSET_PX = 50; // breathing room above the user message
	let spacerEl: HTMLElement | undefined = $state();
	let messagesEl: HTMLElement | undefined = $state();
	let spacerHeight = $state(MIN_SPACER_PX);
	let spacerActive = $state(0); // 0 = inactive, >0 = active (counter to force effect re-run)
	// The spacer only exists to keep a NEW question pinned near the top while its answer streams.
	// Once the turn finishes it collapses to a small rest padding, so no blank space is reserved under
	// the latest answer (the browser clamps the scroll position, keeping the answer's end in view).
	const REST_SPACER_PX = 24;
	let renderedSpacerPx = $derived(spacerActive > 0 && loading ? spacerHeight : REST_SPACER_PX);

	// Strict top-anchor (ChatGPT-style): as a response grows the spacer shrinks to keep the new user
	// message pinned at the top, but it floors at MIN_SPACER_PX. Past that floor, following the streaming
	// bottom would drag the user message off the top (the "long responses scroll to the end"
	// failure), so once floored we STOP following and let the response overflow below the fold.
	//
	// Anchored for the WHOLE top-anchor phase (spacerActive > 0), not only once floored: while pre-floor,
	// content growth is offset by spacer shrinkage, so scrollHeight is meant to stay constant and
	// snapScrollToBottom's own resize-driven scrollToBottom() (raw "jump to scrollHeight", no 50px-from-
	// message precision) is a no-op then anyway. But that observer watches a DIFFERENT element (the
	// mx-auto wrapper) than this effect's own precise re-pin does, so an UNRELATED resize of chatContainer
	// itself (e.g. GuestRetentionNotice mounting above it) can fire it with a still-stale scrollHeight —
	// landing on the wrong absolute position and racing this effect's own correction. Gating on
	// spacerHeight alone leaves the just-sent message pinned ~150px above the fold,
	// permanently, on exactly that mount (CUR-1576). Keeping followBottom off for the entire phase removes the race
	// instead of trying to win it — this effect's own scrollTop re-pin (below) is the only writer left.
	let anchoredTop = $derived(spacerActive > 0);

	// Combined scroll dependency for the action (followBottom off = strict top-anchor, no bottom-chase).
	let scrollDependency = $derived({ forceReattach, scrollBehavior, followBottom: !anchoredTop });

	// Absolute (scroll-position-independent) offset of the last user message within
	// chatContainer's scrollable content — adding the current scrollTop back cancels out
	// the viewport-relative delta, so this always recovers the same value regardless of
	// where we're currently scrolled to. Unlike deriving a target from scrollHeight, this
	// doesn't depend on the spacer's rendered height matching this tick's computation, so
	// it can't drift when a reply arrives in one large chunk that jumps straight past the
	// spacer's floor within a single resize tick (CAI-77).
	function getLastUserMsgScrollTop(): number | null {
		if (!chatContainer) return null;
		const userMsgs = chatContainer.querySelectorAll('[data-message-type="user"]');
		const lastUserMsg = userMsgs[userMsgs.length - 1] as HTMLElement | undefined;
		if (!lastUserMsg) return null;
		const containerRect = chatContainer.getBoundingClientRect();
		return lastUserMsg.getBoundingClientRect().top - containerRect.top + chatContainer.scrollTop;
	}

	function computeSpacerHeight(): number {
		if (!chatContainer || !spacerEl) return MIN_SPACER_PX;

		const userMsgScrollTop = getLastUserMsgScrollTop();
		if (userMsgScrollTop === null) return MIN_SPACER_PX;

		const viewportHeight = chatContainer.clientHeight;
		const containerRect = chatContainer.getBoundingClientRect();
		const scrollTop = chatContainer.scrollTop;

		// Use the spacer element's own position as reference — this naturally accounts
		// for all flex gaps, padding, and layout between the user message and the spacer.
		const spacerScrollTop = spacerEl.getBoundingClientRect().top - containerRect.top + scrollTop;

		const contentHeight = spacerScrollTop - userMsgScrollTop;
		return Math.max(MIN_SPACER_PX, viewportHeight - contentHeight - SPACER_TOP_OFFSET_PX);
	}

	$effect(() => {
		// Don't gate on `loading` — the spacer must be computed immediately when
		// spacerActive is set (same tick as forceReattach++) so that the spacer
		// height is correct BEFORE snapScrollToBottom's scrollToBottom() fires.
		if (!spacerActive || !chatContainer || !messagesEl) return;

		const container = chatContainer;

		// Observe the messages wrapper (has h-max, resizes with content)
		// instead of the mx-auto container (has h-full, may not resize — see
		// snapScrollToBottom.ts's own ResizeObserver, which is why it can't
		// pick up this slack on its own). ALSO observe `container` itself
		// (chatContainer is flex-1, sharing a column with GuestRetentionNotice
		// and ConnectionStatus): on the first message of a brand-new
		// conversation, GuestRetentionNotice mounts one tick late (gated on
		// messages.length > 0, which only flips true once this effect has
		// already run once), shrinking chatContainer's clientHeight without
		// touching messagesEl at all — messagesEl alone can't see that. The banner
		// shrinks containerHeight (252->225) the instant it appears, and with only messagesEl observed the
		// just-sent user message ends up pinned 180px above the now-shorter viewport, permanently,
		// since nothing re-fires to correct it (CUR-1576).
		//
		// Re-pin scrollTop to the user message's fixed absolute offset on every
		// resize tick WHILE THE TURN IS STILL LOADING ONLY. `spacerActive` stays
		// truthy for the rest of the conversation (it's only reset on a genuine
		// conversation switch), so without the `loading` check this observer
		// would keep firing — and re-pinning — on ANY later resize of the
		// message list: a window resize, a mobile-keyboard toggle, or a
		// provenance/safety badge arriving after the stream ends. That yanked a
		// user who'd scrolled up to reread earlier history back down to the last
		// turn. Checked per-tick rather than gating the
		// effect itself, so the synchronous computeSpacerHeight() call below
		// still runs immediately when spacerActive is set, same tick as
		// forceReattach++ (see the comment above this effect) (CAI-77).
		//
		// The re-pin also stops for the rest of the turn once the reader scrolls the conversation
		// themselves: without that, every streamed chunk pulled a reader who had scrolled down to keep
		// reading back to the top of the answer (CUR-2526). The effect re-runs on the next send
		// (spacerActive changes), which resets this, so the following turn pins as usual. Only real
		// input counts (wheel, touch, scroll keys, a scrollbar drag), since this observer's own
		// scrollTop writes and the browser's clamping also fire scroll events.
		let readerScrolled = false;
		const markReaderScrolled = () => {
			readerScrolled = true;
		};
		const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);
		const onKeydown = (event: KeyboardEvent) => {
			if (!SCROLL_KEYS.has(event.key)) return;
			const target = event.target as HTMLElement | null;
			if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
			readerScrolled = true;
		};
		// A pointerdown whose target is the scroll container itself lands on its scrollbar.
		const onPointerdown = (event: PointerEvent) => {
			if (event.target === container) readerScrolled = true;
		};
		const stopListening = [
			on(container, 'wheel', markReaderScrolled, { passive: true }),
			on(container, 'touchmove', markReaderScrolled, { passive: true }),
			on(container, 'pointerdown', onPointerdown, { passive: true }),
			on(window, 'keydown', onKeydown, { passive: true })
		];

		const observer = new ResizeObserver(() => {
			spacerHeight = computeSpacerHeight();
			if (!loading || readerScrolled) return;
			const userMsgScrollTop = getLastUserMsgScrollTop();
			if (userMsgScrollTop === null) return;
			container.scrollTop = Math.max(0, userMsgScrollTop - SPACER_TOP_OFFSET_PX);
		});
		observer.observe(messagesEl);
		observer.observe(container);
		spacerHeight = computeSpacerHeight();

		return () => {
			observer.disconnect();
			for (const stop of stopListening) stop();
		};
	});

	const settings = useSettingsStore();
	let hideRouterExamples = $derived($settings.hidePromptExamples?.[currentModel.id] ?? false);

	// First-run orientation overlay. Mirrors prod's ChatShell: shown once per
	// browser on a FRESH chat (no messages), gated here in the chat panel so the
	// live-stack map stays visible beside it on desktop. Persistence is the
	// existing `welcomeModalSeen` setting; returning visitors / loaded histories
	// don't see it. A shared conversation view (near-always has messages already)
	// can never satisfy this gate — AiDisclosureBanner below is that path's own,
	// lighter Art. 50 disclosure instead (CUR-996).
	let chatInputRef = $state<ReturnType<typeof ChatInput>>();
	// Not after a wipe in this same page session (CUR-2270, see wipedThisSession).
	// Held from the moment the welcome starts to close until its close animation ends: the seen mark is
	// saved at the start (CUR-4348), and on its own it would unmount the welcome mid-animation, before
	// it hands over.
	let welcomeLeaving = $state(false);
	let showWelcome = $derived(
		welcomeLeaving || welcomeReplay.open || (!$settings.welcomeModalSeen && !$wipedThisSession && !shared && messages.length === 0)
	);
	// Empty conversation → the composer renders centred under the greeting instead of docked.
	let emptyState = $derived(messages.length === 0 && !pending);

	// The landing is centred, so a photo row growing the composer moved the message box out
	// from under the person about to type. While files are attached, the block is lifted back into
	// the centring above it. On a window where that centring is too small, the block is pinned to the
	// top of the column instead (both margins set, since an inline bottom margin alone hands the freed
	// space to the auto top margin and slides the block down) and the column scrolls the rest, with
	// room added below the block for it to scroll into, until the heading reaches the top; past that
	// the box moves rather than the greeting leaving the screen. Positions are read in the column's content
	// coordinates, so the scroll itself never reads as the box moving. The rest position is re-read
	// whenever nothing is attached, and after a window resize. (CUR-3617)
	let landingEl = $state<HTMLDivElement>();
	// Space kept between the column's top edge and the greeting's heading when the column scrolls.
	const HEADING_GAP = 12;
	$effect(() => {
		const el = landingEl;
		const scroller = chatContainer;
		if (!el) return;
		let restTop: number | undefined;
		let restScroll = 0;
		const release = () => {
			el.style.transform = '';
			el.style.marginTop = '';
			el.style.marginBottom = '';
		};
		const settle = () => {
			const box = el.querySelector<HTMLElement>('[data-chat-input]');
			if (!box) return;
			// Measure the centred layout with no correction applied.
			release();
			const contentTop = (node: Element) => node.getBoundingClientRect().top + (scroller?.scrollTop ?? 0);
			const top = contentTop(box);
			if (files.length === 0 && get(preparingPhotos) === 0) {
				restTop = top;
				restScroll = scroller?.scrollTop ?? 0;
				return;
			}
			restTop ??= top;
			const drop = top - restTop;
			// The centring left above the block, measured from what sits above it: on a short viewport it
			// already sits at the top, and a lift past that hides the greeting where nobody can scroll to it.
			const above = el.previousElementSibling;
			const parent = el.parentElement;
			const floor = above
				? above.getBoundingClientRect().bottom +
					(parseFloat(getComputedStyle(parent ?? el).rowGap) || 0)
				: parent
					? parent.getBoundingClientRect().top + (parseFloat(getComputedStyle(parent).paddingTop) || 0)
					: 0;
			const room = Math.max(el.getBoundingClientRect().top - floor, 0);
			if (drop <= room || !scroller) {
				el.style.transform = drop ? `translateY(${-Math.min(drop, room)}px)` : '';
				return;
			}
			// Pin the block where the centring ends, then scroll whatever of the drop is left.
			el.style.marginTop = '0px';
			el.style.marginBottom = '0px';
			const left = contentTop(box) - restTop;
			if (left < 0) el.style.marginTop = `${-left}px`;
			// Scroll no further than puts the greeting's heading at the column's top edge. Holding the box
			// still past that point hid the heading under the top bar, so the rest of the drop moves the
			// box instead (CUR-3617).
			const heading = el.querySelector('h2');
			const headingLimit = heading
				? contentTop(heading) - scroller.getBoundingClientRect().top - HEADING_GAP
				: Number.POSITIVE_INFINITY;
			const target = Math.min(restScroll + Math.max(left, 0), Math.max(headingLimit, restScroll));
			// Free space the column still has below the block absorbs added room before any of it scrolls.
			const free = parent
				? Math.max(
						parent.getBoundingClientRect().bottom -
							(parseFloat(getComputedStyle(parent).paddingBottom) || 0) -
							el.getBoundingClientRect().bottom,
						0
					)
				: 0;
			const overflow = scroller.scrollHeight - scroller.clientHeight;
			el.style.marginBottom = `${free + Math.max(target - overflow, 0)}px`;
			scroller.scrollTop = target;
		};
		const onResize = () => {
			restTop = undefined;
			release();
		};
		const observer = new ResizeObserver(settle);
		observer.observe(el);
		const offResize = on(window, 'resize', onResize);
		return () => {
			observer.disconnect();
			offResize();
			release();
		};
	});

	// The empty-state's own retention line (ChatIntroduction) disappears the moment a guest
	// sends their first message — exactly when they'd have something to lose. This covers the gap:
	// anonymous, not viewing someone else's shared conversation, and a conversation actually exists
	// (sent or pending) rather than the still-empty composer, where ChatIntroduction already covers it. (CUR-643)
	let showGuestRetentionNotice = $derived(
		!page.data.user && !shared && (messages.length > 0 || pending)
	);

	function dismissWelcome() {
		welcomeLeaving = true;
		welcomeReplay.open = false;
		if (requireAuthUser()) return;
		void settings.instantSet({ welcomeModalSeen: true });
		// starter_prompt_used isn't populated: the welcome mat itself offers no starter option
		// (those live in the empty-state composer, a separate surface) — nothing honest to report yet.
		trackEvent('onboarding_completed', {});
	}

	// The welcome hands over to the guided tour; one that finds none of its features on screen leaves
	// the person at the composer, as Start chatting would.
	function handleWelcomeTour() {
		welcomeLeaving = false;
		if (!tour.start('welcome')) handleWelcomeStart();
	}

	// A skip: the composer is theirs, and the hint above the sidebar's account row says the tour is
	// in that menu. Where the row isn't on screen (a phone's closed drawer, the collapsed rail), a
	// toast says the same, with a "Show me" that opens the sidebar onto the hint.
	const shell = getAppShell();
	const compact = useCompact();
	const toasts = useToastManager();
	function handleWelcomeStart() {
		welcomeLeaving = false;
		// The welcome hands over once its close animation ends. Someone who already clicked into the
		// page by then keeps what they clicked; only focus left on the welcome or nowhere moves here.
		const focused = document.activeElement;
		if (!focused || focused === document.body || focused.closest('[data-welcome]')) chatInputRef?.focusComposer();
		if (embeddedDemo) return;
		tour.showHint();
		if (!compact.current && !shell.collapsed) return;
		toasts.add({
			id: 'tour-hint',
			title: m.tour_hintToast(),
			timeout: 8000,
			testId: 'tour-hint-toast',
			action: {
				label: m.tour_hintShowMe(),
				onClick: () => (compact.current ? shell.setMobileOpen(true) : shell.toggleSidebar())
			}
		});
	}

	// Respect per‑model multimodal toggle from settings (force enable)
	// The model the next message goes to, as far as images are concerned. With Auto routing on, a model
	// picked in the composer is held in modelChoice, not in currentModel (the settings default), so the
	// composer offered photos for the default while the message went to a text-only pick.
	let nextModel = $derived.by(() => {
		// Mid-chat, a model already settled on for the next message (a pick, or Auto's switch for a photo).
		const settled = $nextTurnModel && $nextTurnModel.text === undefined ? $nextTurnModel.modelId.toLowerCase() : undefined;
		const pending = settled ? models.find((model) => model.id.toLowerCase() === settled) : undefined;
		if (pending) return pending;
		if (page.data.autoRoutingEnabled !== true || $modelChoice === AUTO) return currentModel;
		const gatewayId = catalog.find((entry) => entry.id === $modelChoice)?.gatewayId;
		const picked = gatewayId ? models.find((model) => servedKey(model.id) === servedKey(gatewayId)) : undefined;
		return picked ?? currentModel;
	});
	let nextModelLabel = $derived(resolveModelIdentity(nextModel.id).short);
	// The models here that read photos, for "Use Mistral Large 3" and for Auto, which takes a photo to one.
	let photoReaders = $derived(models.filter((model) => model.multimodal === true && !model.unlisted));
	let photoReaderLabel = $derived(photoReaders[0] ? resolveModelIdentity(photoReaders[0].id).short : undefined);
	// With Auto choosing, a photo is welcome wherever some model reads photos: Auto takes it to one
	// (ChatComposerFrame's photoRouting) and says so on the composer.
	let autoChoosing = $derived(page.data.autoRoutingEnabled === true && $modelChoice === AUTO);
	let imageModel = $derived(
		autoChoosing && photoReaders.length > 0 && nextModel.multimodal !== true ? photoReaders[0] : nextModel
	);
	// Whether "pick a model that reads photos" is advice anyone could take. Never under Auto, which takes a
	// photo to a reader itself, so a refused photo there is never the chosen model's fault.
	let photoModelPickable = $derived(
		page.data.attachmentsEnabled === true && photoReaders.length > 0 && !autoChoosing
	);
	let modelIsMultimodalOverride = $derived($settings.multimodalOverrides?.[imageModel.id]);
	let modelIsMultimodal = $derived((modelIsMultimodalOverride ?? imageModel.multimodal) === true);
	// "Use Mistral Large 3": picks the first model that reads photos, as the picker would.
	function usePhotoReader() {
		const reader = photoReaders[0];
		const entry = reader ? catalogByGatewayId(reader.id) : undefined;
		if (entry) modelPickRequest.set(entry.id);
	}
	// Guests cannot attach files: where sign-in is offered, every way of attaching asks for
	// it instead. The server refuses a guest's file too (parseRequest).
	let signInToAttach = $derived(
		!page.data.user && page.data.loginEnabled === true && page.data.attachmentsEnabled === true
	);
	function goSignIn() {
		void goto(`${base}/login?next=${encodeURIComponent(page.url.pathname + page.url.search)}`);
	}
	function askSignInToAttach() {
		attachmentRefusal.set({ message: m.product_signInToAttach(), fix: 'sign-in' });
	}

	// The settings page's "Reasoning effort" switch only sets the boolean gate below —
	// this is the selector its own copy promises ("Show a Low / Medium / High selector in the
	// chat footer"), the only place reasoningEffortOverrides ever gets written. (CUR-680)
	let showReasoningEffort = $derived(
		($settings.reasoningOverrides?.[currentModel.id] ?? currentModel.supportsReasoning) === true
	);
	function getReasoningEffort() {
		return $settings.reasoningEffortOverrides?.[currentModel.id] ?? "medium";
	}
	function setReasoningEffort(v: ReasoningEffort) {
		settings.update((s) => ({
			...s,
			reasoningEffortOverrides: { ...s.reasoningEffortOverrides, [currentModel.id]: v }
		}));
	}

	// Text files always, PDF/DOCX where the server reads them (CUR-987), images when the model takes
	// them, nothing at all where the server refuses every upload (CUR-2382): see offeredMimeTypes.
	let activeMimeTypes = $derived(
		offeredMimeTypes({
			attachmentsEnabled: page.data.attachmentsEnabled === true,
			uploadsEnabled: page.data.imageInputEnabled === true && !signInToAttach,
			documentsEnabled: page.data.documentAttachmentsEnabled === true,
			modelIsMultimodal,
			modelImageMimeTypes: imageModel.multimodalAcceptedMimetypes
		})
	);
	let isFileUploadEnabled = $derived(activeMimeTypes.length > 0);
	// A text-only model never sees a photo: the endpoint leaves images out of what it sends such a model
	// (prepareMessagesWithFiles). Said in the attach menu, and under the files once a photo is attached,
	// wherever another model here does read images, so picking one is a choice the person can make.
	let imagesOffered = $derived(activeMimeTypes.some((type) => type.startsWith('image/')));
	let imagesReadElsewhere = $derived(!imagesOffered && photoReaders.length > 0);
	let attachNote = $derived(
		isFileUploadEnabled && imagesReadElsewhere && photoReaderLabel
			? m.product_modelReadsNoImages({ model: nextModelLabel, reader: photoReaderLabel })
			: undefined
	);
	let photosNotRead = $derived(
		!imagesOffered && (files ?? []).some((file) => file.type.startsWith('image/'))
	);
	// Dismissing the line hides it for this model; picking another model brings it back if it applies.
	let photosNoticeDismissedFor = $state<string | null>(null);
	// A refusal said for one model ("Apertus can't read photos") is stale once another is picked.
	let refusalModel: string | undefined;
	$effect(() => {
		const id = nextModel.id;
		if (refusalModel !== undefined && id !== refusalModel) attachmentRefusal.set(undefined);
		refusalModel = id;
	});
	// Files can be dropped anywhere in the chat, not only on the box that stands in for the composer
	// while dragging: a file let go over the conversation is never discarded without a word.
	// The toast stack sits in the bottom-right corner on desktop. While the composer is docked at the
	// bottom it would cover Send, so the composer publishes how much of the window's bottom it takes
	// (--toast-clearance) and the stack sits above it.
	let composerEl: HTMLFormElement | undefined = $state();
	let measureClearance: (() => void) | undefined;
	$effect(() => {
		const el = composerEl;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const root = document.documentElement;
		const measure = () => {
			const rect = el.getBoundingClientRect();
			const docked = rect.bottom > window.innerHeight - 160;
			root.style.setProperty('--toast-clearance', docked ? `${Math.max(0, window.innerHeight - rect.top)}px` : '0px');
		};
		measure();
		measureClearance = measure;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		if (el.parentElement) observer.observe(el.parentElement);
		observer.observe(document.body);
		window.addEventListener('resize', measure);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', measure);
			measureClearance = undefined;
			root.style.removeProperty('--toast-clearance');
		};
	});
	$effect(() => {
		// The composer docks once the conversation starts, which moves it without resizing it.
		void messages.length;
		requestAnimationFrame(() => measureClearance?.());
	});

	let dropEnabled = $derived(
		(isFileUploadEnabled || signInToAttach) && !isReadOnly && !isRecording && !isTranscribing
	);
	let focused = $state(false);

	let activeRouterExamplePrompt = $state<string | null>(null);
	let activeExamples = $derived<RouterExample[]>(routerExamples);
	let routerFollowUps = $derived<RouterFollowUp[]>(
		activeRouterExamplePrompt
			? (activeExamples.find((ex) => ex.prompt === activeRouterExamplePrompt)?.followUps ?? [])
			: []
	);
	let routerUserMessages = $derived(messages.filter((msg) => msg.from === 'user'));
	let shouldShowRouterFollowUps = $derived(
		!draft.length &&
			activeRouterExamplePrompt &&
			routerFollowUps.length > 0 &&
			routerUserMessages.length === 1 &&
			currentModel.isRouter &&
			!hideRouterExamples &&
			!loading
	);

	$effect(() => {
		if (!currentModel.isRouter || !messages.length) {
			activeRouterExamplePrompt = null;
			return;
		}

		const firstUserMessage = messages.find((msg) => msg.from === 'user');
		if (!firstUserMessage) {
			activeRouterExamplePrompt = null;
			return;
		}

		const match = activeExamples.find((ex) => ex.prompt.trim() === firstUserMessage.content.trim());
		activeRouterExamplePrompt = match ? match.prompt : null;
	});

	$effect(() => {
		if ($pendingChatInput) {
			draft = $pendingChatInput;
			pendingChatInput.set(undefined);
		}
	});

	// A refused edit reopens its own message's edit box, which takes the text and reason. (CUR-2825)
	$effect(() => {
		if ($refusedEdit) editMsdgId = $refusedEdit.id;
	});

	// A button that answers for the visitor (the low-resource notice's "Try anyway") sends
	// through the composer's own path, so it is tracked and guarded like a typed message. (CUR-1841)
	function sendAsVisitor(text: string) {
		if (requireAuthUser() || loading) return;
		draft = text;
		handleSubmit();
	}

	function triggerPrompt(prompt: string) {
		if (requireAuthUser() || loading) return;
		draft = prompt;
		sentViaStarterPrompt = true;
		handleSubmit();
	}

	async function startExample(example: RouterExample) {
		if (requireAuthUser()) return;
		activeRouterExamplePrompt = example.prompt;

		if (browser && example.attachments?.length) {
			const loadedFiles: File[] = [];
			for (const attachment of example.attachments) {
				try {
					const response = await fetch(`${base}/${attachment.src}`);
					if (!response.ok) continue;

					const blob = await response.blob();
					const name = attachment.src.split('/').pop() ?? 'attachment';
					loadedFiles.push(
						new File([blob], name, { type: blob.type || 'application/octet-stream' })
					);
				} catch (err) {
					console.error('Error loading attachment:', err);
				}
			}
			files = loadedFiles;
		}

		triggerPrompt(example.prompt);
	}

	function startFollowUp(followUp: RouterFollowUp) {
		triggerPrompt(followUp.prompt);
	}

	/** The recording's text, or undefined with the reason already in the error banner. A recording over
	 *  the limit is refused here, before the upload, with the sentence the server would send (CUR-2631). */
	async function transcribe(audioBlob: Blob): Promise<string | undefined> {
		if (audioBlob.size > VOICE_RECORDING_MAX_BYTES) {
			$error = voiceRecordingTooLargeMessage();
			return undefined;
		}
		try {
			const response = await fetch(`${base}/api/transcribe`, {
				method: 'POST',
				headers: { 'Content-Type': audioBlob.type },
				body: audioBlob
			});
			if (response.status === 413) {
				$error = voiceRecordingTooLargeMessage();
				return undefined;
			}
			// A timeout and a rate limit carry a sentence written for the visitor ("try a shorter
			// recording"); any other failure's body is upstream text, so it keeps the generic line (CUR-2801).
			if (response.status === 429 || response.status === 504) {
				const body = await response.json().catch(() => null);
				$error = body?.message || 'Transcription failed. Please try again.';
				return undefined;
			}
			if (!response.ok) {
				throw new Error(await response.text());
			}
			const { text } = await response.json();
			return text?.trim() || undefined;
		} catch (err) {
			console.error('Transcription error:', err);
			$error = 'Transcription failed. Please try again.';
			return undefined;
		}
	}

	async function handleRecordingConfirm(audioBlob: Blob) {
		isRecording = false;
		dictationBlocked = undefined;
		isTranscribing = true;

		try {
			const trimmedText = await transcribe(audioBlob);
			if (trimmedText) {
				// Append transcribed text to draft
				draft = draft.trim() ? `${draft.trim()} ${trimmedText}` : trimmedText;
			}
		} finally {
			isTranscribing = false;
			// The textarea that had focus before recording started was a different DOM node
			// (VoiceRecorder replaced, then unmounted, the whole ChatInput) — without this, focus
			// silently drops to <body> once transcription lands. Deferred a tick, same as
			// handleWelcomeStart, so it runs after the composer has actually remounted.
			setTimeout(() => chatInputRef?.focusComposer(), 0);
		}
	}

	async function handleRecordingSend(audioBlob: Blob) {
		isRecording = false;
		dictationBlocked = undefined;
		isTranscribing = true;

		try {
			const trimmedText = await transcribe(audioBlob);
			if (trimmedText) {
				// Set draft and send immediately
				draft = draft.trim() ? `${draft.trim()} ${trimmedText}` : trimmedText;
				handleSubmit();
			}
		} finally {
			isTranscribing = false;
			setTimeout(() => chatInputRef?.focusComposer(), 0);
		}
	}

	function handleRecordingError(message: string, blocked?: string) {
		console.error('Recording error:', message);
		isRecording = false;
		dictationBlocked = blocked;
		$error = message;
		setTimeout(() => chatInputRef?.focusComposer(), 0);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && $stackOpen) stackOpen.set(false);
	}}
	ondragenter={onDragEnter}
	ondragleave={onDragLeave}
	ondragover={(e) => {
		e.preventDefault();
	}}
	ondrop={onDrop}
/>

<!-- Conversation column + XRAY side panel, built on the Alpha design system (AppShell.Main is
     the parent). Chat-app shape: ThreadHeader, a thread-width column, and a composer that
     sits centred under the greeting while the conversation is empty and docks to the bottom once
     it starts. -->
<div class="relative flex h-full min-h-0 min-w-0 flex-1 flex-row">
	<!-- Single, top-level contribute dialog (store-driven). -->
	<ContributeDialog />
	<!-- Honest "weak spots" disclosure, opened from the composer footer link. -->
	<WeakSpotsModal />
	<div role="main" aria-label={m.product_chat()} class="relative flex min-h-0 min-w-0 flex-1 flex-col">
		<!-- One per-page H1 for the screen-reader/document outline; the ThreadHeader title is visual. -->
		<h1 class="sr-only">{m.chat_pageHeading()}</h1>

		<ThreadHeader openSidebarLabel={m.product_openSidebar()}>
			{#snippet title()}
				{#if messages.length}
					<!-- The title is a menu of conversation-level actions. -->
					<Menu.Root>
						<Menu.Trigger variant="ghost" size="sm" casing="sentence" class="max-w-full min-w-0 shrink">
							<span class="truncate font-medium text-fg-1" data-testid="thread-title"
								>{threadTitle.title || 'New Chat'}</span
							>
							<RiArrowDownSLine aria-hidden="true" />
						</Menu.Trigger>
						<Menu.Portal>
							<Menu.Positioner align="start">
								<Menu.Popup>
									{#if threadTitle.renameCurrent}
										<Menu.Item onSelect={() => (renameThreadOpen = true)}>
											<RiPencilLine aria-hidden="true" /> Rename
										</Menu.Item>
									{/if}
									<Menu.Item onSelect={exportChat}>
										<RiDownloadLine aria-hidden="true" /> Export as Markdown
									</Menu.Item>
									{#if threadTitle.deleteCurrent}
										<Menu.Separator />
										<Menu.Item tone="destructive" onSelect={() => (deleteThreadOpen = true)}>
											<RiDeleteBinFill aria-hidden="true" /> Delete conversation
										</Menu.Item>
									{/if}
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>
				{:else}
					<h2 class="truncate type-body font-medium text-fg-1">{threadTitle.title || m.product_newChat()}</h2>
				{/if}
				<!-- Guests: a small "deletes in N days" badge beside the title; tap for the details. -->
				{#if showGuestRetentionNotice}
					<GuestRetentionNotice />
				{/if}
			{/snippet}
			{#snippet actions()}
				<!-- XRAY moved to the composer (an X-ray pill beside Private); the header keeps the footprint,
				     top-right at every size — the compact trigger on phones, the full one on larger screens. -->
				<div class="hidden md:block"><SessionFootprint forget={false} {embeddedDemo} {onDemoForgetEverything} /></div>
				<div class="md:hidden"><SessionFootprint compact forget={false} {embeddedDemo} {onDemoForgetEverything} /></div>
			{/snippet}
		</ThreadHeader>
		{#if !embeddedDemo}
			<GuidedTour />
		{/if}
		{#if showWelcome}
			<WelcomeModal onTakeTour={handleWelcomeTour} onStartChatting={handleWelcomeStart} onDismiss={dismissWelcome} />
		{:else if shared}
			<AiDisclosureBanner />
		{/if}
		{#if featureAnnouncement && showFeatureAnnouncement}
			<FeatureAnnouncementToast announcement={featureAnnouncement} />
		{/if}
		<ConnectionStatus />
		<div
			class="scrollbar-custom relative min-h-0 flex-1 overflow-y-auto scroll-fade-y"
			data-testid="chat-scroll"
			use:snapScrollToBottom={scrollDependency}
			bind:this={chatContainer}
		>
			<!-- New chat: the Bold /alpha drift and build fields as one, theme-aware, behind the greeting. -->
			{#if emptyState && !shared && !embeddedDemo}
				<ChatBackdrop />
			{/if}
			<!-- @container: descendants adapt to the actual column width (it shrinks when a side
			     panel opens). min-h-full (not h-full) so the column GROWS while a reply streams —
			     snapScrollToBottom's ResizeObserver needs that growth to follow the cursor. -->
			<div class="@container relative mx-auto flex min-h-full w-full max-w-thread flex-col gap-6 px-4 pt-6 sm:gap-8 xl:pt-10">
				{#if preprompt && preprompt != currentModel.preprompt}
					<SystemPromptModal preprompt={preprompt ?? ''} />
				{/if}

				{#if messages.length > 0}
					<div bind:this={messagesEl} class="flex h-max flex-col gap-8">
						{#each messages as message, idx (message.id)}
							<ChatMessage
								{loading}
								{message}
								turnNumber={idx + 1}
								modelId={currentModel.id}
								gap={message.from === 'assistant'
									? (gapForPrompt(messages[idx - 1]?.content) ??
										(message.id === firstWebGroundedId
											? webSearchGapFor(message.content, page.data.uiLang)
											: undefined))
									: undefined}
								question={message.from === 'assistant' ? messages[idx - 1]?.content : undefined}
								alternatives={messagesAlternatives.find((a) => a.includes(message.id)) ?? []}
								isAuthor={!shared}
								readOnly={isReadOnly}
								isLast={idx === messages.length - 1}
								bind:editMsdgId
								onretry={(payload) => onretry?.(payload)}
								onshowAlternateMsg={(payload) => onshowAlternateMsg?.(payload)}
								onquote={!shared && !isReadOnly && !formerWorkspace ? quoteToComposer : undefined}
								onsend={!shared && !isReadOnly && !formerWorkspace ? sendAsVisitor : undefined}
							/>
						{/each}
						{#if showPendingPlaceholder}
							<ChatMessage
								loading={true}
								isLast={true}
								message={{
									id: 'pending-placeholder',
									content: '',
									from: 'assistant',
									children: []
								}}
								isAuthor={!shared}
								readOnly={isReadOnly}
							/>
						{/if}
						{#if isReadOnly}
							<ModelSwitch {models} {currentModel} />
						{/if}
					</div>
					<!-- Dynamic bottom spacer: large when streaming new message, shrinks as response grows -->
					<div bind:this={spacerEl} class="flex-shrink-0" style:height="{renderedSpacerPx}px"></div>
				{:else if pending}
					<ChatMessage
						loading={true}
						isLast={true}
						message={{
							id: '0-0-0-0-0',
							content: '',
							from: 'assistant',
							children: []
						}}
						isAuthor={!shared}
						readOnly={isReadOnly}
					/>
				{:else}
					<!-- Empty conversation: greeting, then the composer right under it. -->
					<div
						bind:this={landingEl}
						class="my-auto flex w-full flex-col gap-6 pb-10"
						data-backdrop-exclude
					>
						<ChatIntroduction
							currentModel={nextModel}
							auto={page.data.autoRoutingEnabled === true && $modelChoice === AUTO}
							onmessage={(content) => onmessage?.(content)}
						>
							{@render composer()}
						</ChatIntroduction>
					</div>
				{/if}
			</div>
		</div>

		{#if !emptyState}
			<!-- Composer band. Opaque surface across the full width (so content scrolling underneath is
			     hidden edge to edge), with a fixed-height fade strip above it whose length is independent
			     of how tall the composer grows. -->
			<div class="relative z-sticky flex w-full shrink-0 flex-col items-center bg-surface pt-2 pb-3 md:pb-4">
				{#if scrollButtonVisible}
					<!-- CUR-1630: the jump button floats over the answer while the reader is scrolled up, and the
					     scroller's own edge fade is only a quarter opaque at its height, so it hid words that were
					     still readable. This strip is solid across its lower half, which covers the text beneath
					     the button; its upper half dissolves into the answer. Desktop only, like the button. -->
					<div
						transition:fade={{ duration: 150 }}
						class="pointer-events-none absolute inset-x-0 bottom-full hidden h-28 bg-linear-to-t from-surface from-50% to-surface/0 md:block"
						aria-hidden="true"
					></div>
				{/if}
				<!-- Jump-to-bottom rides in the fade strip; desktop only (mobile: implied swipe). -->
				<ScrollToBottomBtn
					class="bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 max-md:hidden"
					scrollNode={chatContainer}
					bind:visible={scrollButtonVisible}
				/>
				<div class="flex w-full max-w-thread flex-col px-4">
					{@render composer()}
				</div>
			</div>
		{/if}
	</div>

	{#snippet composer()}
		{#if !draft.length && !messages.length && !sources.length && !loading && currentModel.isRouter && activeExamples.length && !hideRouterExamples && !lastIsError}
			<div class="mb-3 flex w-full flex-wrap gap-2">
				{#each activeExamples as ex (ex.prompt)}
					<EmptyStateSuggestion onclick={() => startExample(ex)}>
						<span class="inline-flex items-center gap-1.5">
							{ex.title}
							{#if ex.artifact}<RiSparkling class="size-3 flex-none text-accent-1-text" aria-hidden="true" />{/if}
						</span>
					</EmptyStateSuggestion>
				{/each}
			</div>
		{/if}
		{#if shouldShowRouterFollowUps && !lastIsError}
			<div class="mb-3 flex w-full flex-wrap gap-2">
				{#each routerFollowUps as followUp (followUp.prompt)}
					<EmptyStateSuggestion onclick={() => startFollowUp(followUp)}>
						<span class="inline-flex items-center gap-1"><RiArrowRightS class="size-3.5 scale-y-[-1]" aria-hidden="true" />{followUp.title}</span>
					</EmptyStateSuggestion>
				{/each}
			</div>
		{/if}
		{#if $attachmentWarning && sources?.length && !loading}
			<p class="w-full pb-2 text-small text-fg-2" role="status" data-testid="attachment-allowance-near">
				{$attachmentWarning}
			</p>
		{/if}

		<!-- The composer's accessory row (privacy + XRAY pills) wraps the form, so its panels match the
		     composer's width, and hands the model picker into the composer's toolbar. Absent on
		     read-only / shared views, which can't send. A former workspace's chat gets neither, only
		     the reason it can't be continued. -->
		{#if formerWorkspace}
			<p class="mx-auto w-full max-w-3xl px-4 py-4 text-center type-body text-fg-2" role="status">
				This chat was in {formerWorkspace}, which you're no longer part of, so it's read-only.
			</p>
		{:else if isReadOnly || shared}
			{@render composerForm()}
		{:else}
			<ChatComposerFrame
				{draft}
				currentModelId={currentModel.id}
				servedIds={models.filter((m) => !m.unlisted).map((m) => m.id)}
				started={messages.length > 0}
				{messages}
				{loading}
				{embeddedDemo}
				{onEmbeddedNavigate}
				photoAttached={(files ?? []).some((file) => file.type.startsWith('image/'))}
			>
				{#snippet children(modelPicker)}
					{@render composerForm(modelPicker)}
				{/snippet}
			</ChatComposerFrame>
		{/if}
	{/snippet}

	<!-- The files on this draft, inside the composer above the text (as in Recursive's composer). -->
	{#snippet attachedFiles()}
		<Attachment.Row aria-label="Attached files" data-testid="composer-attachments">
			{#each sources as source, index (index)}
				{#await source then src}
					<UploadedFile
						file={src}
						onclose={() => {
							files = files.filter((_, i) => i !== index);
						}}
					/>
				{/await}
			{/each}
			<!-- CUR-2905: a large photo takes seconds to shrink before it has a card of its own, so the
			     composer says it arrived. -->
			{#each { length: $preparingPhotos } as _, i (i)}
				<Attachment.Card
					name="Preparing photo…"
					kind="Photo"
					busy
					busyLabel="Preparing photo"
					data-testid="preparing-photo"
				/>
			{/each}
		</Attachment.Row>
	{/snippet}

	{#snippet composerForm(modelPicker?: Snippet)}
		<!-- What the composer refused, or a photo the chosen model won't read, said on its top edge:
		     it belongs to this message, not to the app-wide toast. -->
		{#if $attachmentRefusal}
			{@const refusal = $attachmentRefusal}
			<ComposerAccessory.Notice
				icon={RiAttachmentLine}
				dismissLabel={m.product_dismissNotice()}
				ondismiss={() => attachmentRefusal.set(undefined)}
				data-testid="attachment-refusal"
			>
				{refusal.message}
				{#snippet action()}
					{#if refusal.fix === 'sign-in'}
						<Button variant="secondary" size="sm" casing="sentence" onclick={goSignIn}>{m.product_signIn()}</Button>
					{:else if refusal.fix === 'photo-model' && photoReaderLabel}
						<Button variant="ghost" size="sm" casing="sentence" onclick={usePhotoReader}
							>{m.product_useModel({ model: photoReaderLabel })}</Button
						>
					{/if}
				{/snippet}
			</ComposerAccessory.Notice>
		{/if}
		{#if photosNotRead && photosNoticeDismissedFor !== nextModel.id}
			<ComposerAccessory.Notice
				icon={RiImageLine}
				dismissLabel={m.product_dismissNotice()}
				ondismiss={() => (photosNoticeDismissedFor = nextModel.id)}
				data-testid="photos-not-read"
			>
				{m.product_photosNotRead({ model: nextModelLabel })}
				{#snippet action()}
					<div class="flex items-center gap-1">
						{#if photoReaderLabel}
							<Button variant="secondary" size="sm" casing="sentence" onclick={usePhotoReader}
								>{m.product_useModel({ model: photoReaderLabel })}</Button
							>
						{/if}
						<Button
							variant="ghost"
							size="sm"
							casing="sentence"
							onclick={() => (files = files.filter((file) => !file.type.startsWith('image/')))}
							>{m.product_removePhotos()}</Button
						>
					</div>
				{/snippet}
			</ComposerAccessory.Notice>
		{/if}
		<!-- Composer skin = the design system's Composer pattern: Radius 2 (the spec's one rounded
		     input), Background 2, Border 2 → Border 3 on focus, hover-only soft shadow. ChatInput keeps
		     its own internals (attachments, tools, voice, reasoning). -->
		<form
			bind:this={composerEl}
			tabindex="-1"
			data-surface="2"
			aria-label={isFileUploadEnabled ? 'file dropzone' : undefined}
			onsubmit={(e) => {
				e.preventDefault();
				handleSubmit();
			}}
			class={{
				'composer-shell relative flex w-full flex-1 items-center border border-line-2 bg-surface-2 rounded-field transition-control focus-within:border-line-3': true,
				'opacity-40': isReadOnly,
				'max-sm:mb-4': focused && isVirtualKeyboard()
			}}
		>
			{#if heldSeconds > 0}
				<p role="status" aria-live="polite" class="absolute bottom-full left-2 mb-1 text-small text-fg-2">
					{`You can send again in ${heldSeconds} ${heldSeconds === 1 ? 'second' : 'seconds'}.`}
				</p>
			{/if}
			{#if isRecording || isTranscribing}
				<VoiceRecorder
					{isTranscribing}
					{isTouchDevice}
					oncancel={() => {
						isRecording = false;
						dictationBlocked = undefined;
						setTimeout(() => chatInputRef?.focusComposer(), 0);
					}}
					onconfirm={handleRecordingConfirm}
					onsend={handleRecordingSend}
					onerror={handleRecordingError}
				/>
			{:else if onDrag && dropEnabled}
				<FileDropzone />
			{:else}
				<div class="flex w-full flex-1 border-none bg-transparent" class:paste-glow={pastedLongContent}>
					<!-- CUR-1921: the failed turn's own notice says what went wrong and carries the one Retry.
					     CUR-4490: the composer stays open beside it, so someone whose question failed can reword it
					     instead of being sent back to the same Retry. -->
					<ChatInput
						bind:this={chatInputRef}
						placeholder={isReadOnly ? 'This conversation is read-only.' : composerPlaceholder}
						{loading}
						bind:value={draft}
						bind:files
						mimeTypes={activeMimeTypes}
						onsubmit={handleSubmit}
						{onPaste}
						{pastedUrls}
						onlinks={(urls) => (pastedUrls = new Set([...pastedUrls, ...urls]))}
						disabled={isReadOnly}
						reasoningEffortEnabled={showReasoningEffort}
						bind:reasoningEffort={getReasoningEffort, setReasoningEffort}
						showWebSearch={false}
						modelLabel={nextModelLabel}
						attachments={(sources?.length || $preparingPhotos > 0) && !loading ? attachedFiles : undefined}
						{photoModelPickable}
						{attachNote}
						onSignInToAttach={signInToAttach ? goSignIn : undefined}
						{modelPicker}
						transcriptionEnabled={page.data.transcriptionEnabled}
						onstartrecording={() => (isRecording = true)}
						{dictationBlocked}
						bind:webSearchEnabled
						webSearchAffordance={draftLooksRecent && !webSearchEnabled}
						bind:focused
					/>

					<!-- The one primary action: accent-filled pill icon button (spec); Stop while replying. -->
					<div class="absolute right-2 bottom-2">
						{#if loading}
							<Button
								variant="secondary"
								size="icon"
								shape="pill"
								aria-label={m.product_stop()}
								onclick={() => {
									hapticError();
									onstop?.();
								}}
							>
								<RiStopFill aria-hidden="true" />
							</Button>
						{:else}
							<Button
								variant="accent"
								size="icon"
								shape="pill"
								type="submit"
								name="submit"
								aria-label={m.product_send()}
								disabled={!draft.trim() || isReadOnly || draftOverLimit || heldSeconds > 0}
								focusableWhenDisabled={draftOverLimit && !isReadOnly}
								class={draftOverLimit ? 'ui-disabled:pointer-events-auto ui-disabled:cursor-not-allowed' : undefined}
							>
								<RiArrowUpLine aria-hidden="true" />
							</Button>
						{/if}
					</div>
				</div>
			{/if}
		</form>
	{/snippet}



	<ArtifactPanel registry={artifactRegistry} />

	{#if threadTitle.renameCurrent}
		<RenameConversationDialog
			bind:open={renameThreadOpen}
			title={threadTitle.title}
			onrename={(title) => threadTitle.renameCurrent?.(title)}
		/>
	{/if}

	{#if deleteThreadOpen}
		<DeleteConversationModal
			open={deleteThreadOpen}
			title={threadTitle.title}
			onclose={() => (deleteThreadOpen = false)}
			ondelete={() => {
				deleteThreadOpen = false;
				threadTitle.deleteCurrent?.();
			}}
		/>
	{/if}
</div>

<style>
	.paste-glow {
		animation: glow 1s cubic-bezier(0.4, 0, 0.2, 1) forwards;
		will-change: box-shadow;
	}

	@keyframes glow {
		0% {
			box-shadow: 0 0 0 0 rgba(11, 37, 47, 0.5);
		}
		50% {
			box-shadow: 0 0 20px 4px rgba(11, 37, 47, 0.35);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(11, 37, 47, 0);
		}
	}
</style>
