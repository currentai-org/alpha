<script lang="ts">
	import { messageTooLongMessage } from '$lib/chat/utils/messageTooLong';
	import type { Message } from '$lib/chat/types/Message';
	import { getContext, untrack } from 'svelte';
	import { detectCrisisSignal } from '$lib/chat/crisis';
	import CrisisResources from './CrisisResources.svelte';

	import RiArrowUpRight from '~icons/ri/arrow-right-up-line';
	import RiDoubleQuotesL from '~icons/ri/double-quotes-l';

	import RiPencil from '~icons/ri/pencil-line';
	import RiFileCopy from '~icons/ri/file-copy-line';
	import RiCheck from '~icons/ri/check-line';
	import RiErrorWarningLine from '~icons/ri/error-warning-line';
	import UploadedFile from './UploadedFile.svelte';
	import LeftOutFile from './LeftOutFile.svelte';

	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import MediaAudioPlayer from '../players/MediaAudioPlayer.svelte';
	import { page } from '$app/state';
	import { get } from 'svelte/store';
	import { refusedEdit } from '$lib/chat/stores/refusedEdit';
	import { sendHeldUntil } from '$lib/chat/stores/errors';
	import WarmingIndicator from './WarmingIndicator.svelte';
	import { synthesizingAudioFor } from '$lib/chat/stores/speakState';
	import { playOnTap } from '$lib/chat/stores/audioPlayback';
	import { fixAcronymExpansions } from '$lib/chat/utils/fixAcronyms';
	import OpenReasoningResults from './OpenReasoningResults.svelte';
	import Alternatives from './Alternatives.svelte';
	import { requireAuthUser } from '$lib/chat/utils/auth';
	import ArtifactCard from './ArtifactCard.svelte';
	import {
		HELD_REASONING_STATUS,
		MessageReasoningUpdateType,
		MessageUpdateType,
		MessageUpdateStatus
	} from '$lib/chat/types/MessageUpdate';
	import ImageLightbox from './ImageLightbox.svelte';
	import AnswerFooter from '../provenance/AnswerFooter.svelte';
	import { servingRecorded } from '$lib/chat/utils/routerMetadata';
	import { Attachment, Button } from '@aipotluck/alpha-ds';
	import { chromeCopy } from '$lib/chat/chromeCopy';
	import { servedByBackup as isServedByBackup, servedModelId } from '$lib/chat/identity';
	import SafetyBadge from './SafetyBadge.svelte';
	import LiveRequestLog from './LiveRequestLog.svelte';
	import NameNotice from './NameNotice.svelte';
	import CalculationNote from './CalculationNote.svelte';
	import SafetyNotice from './SafetyNotice.svelte';
	import AttachmentNotice from './AttachmentNotice.svelte';
	import AnswerNote from './AnswerNote.svelte';
	import RiRouteLine from '~icons/ri/route-line';
	import { catalogName } from '$lib/chat/routing/repick';
	import HistoryNotice from './HistoryNotice.svelte';
	import PastChatsNotice from './PastChatsNotice.svelte';
	import AgentRouteNotice from './AgentRouteNotice.svelte';
	import SearchUnfinishedNotice from './SearchUnfinishedNotice.svelte';
	import WritePolicyNotice from './WritePolicyNotice.svelte';
	import AgentConfirmPrompt from './AgentConfirmPrompt.svelte';
	import UrlNotice from './UrlNotice.svelte';
	import DispositionNotice from './DispositionNotice.svelte';
	import CacheNotice from './CacheNotice.svelte';
	import { provenanceFacts } from '$lib/chat/utils/trace/provenanceFacts';
	import GapInvite from './GapInvite.svelte';
	import type { StarterGap } from '$lib/chat/constants/starterGaps';
	import ReportButton from './ReportButton.svelte';
	import DeclineChallenge from './DeclineChallenge.svelte';
	import LanguageReportNote from '$lib/chat/components/language-data/LanguageReportNote.svelte';
	import { splitArtifactSegments, stripArtifacts } from '$lib/chat/utils/artifacts';
	import type { ArtifactOperation } from '$lib/chat/utils/artifacts';
	import { plainTextOf, removeCopyNoise } from '$lib/chat/utils/copyText';
	import { showsCacheNotice } from '$lib/chat/messageProvenance';
	import {
		deriveMessageStatus,
		isTurnStillRunning,
		shouldShowEmptyAnswerNotice,
		showsProvenanceReceipt
	} from '$lib/chat/utils/generationState';
	import { producedNoAnswer } from '$lib/chat/utils/producedNoAnswer';
	import { reconcileFinalAnswerText } from '$lib/chat/utils/finalAnswerReconciliation';
	import { textDirection } from '$lib/chat/utils/textDirection';
	import { m } from '$lib/paraglide/messages.js';
	import { syncClientById } from '../../../../../config/thunderbolt';
	import { citationSourceList, parseVisitorSources } from '$lib/chat/utils/visitorSources';
	import { citationOrder } from '$lib/chat/utils/trace/citedIndices';

	interface Props {
		message: Message;
		loading?: boolean;
		isAuthor?: boolean;
		readOnly?: boolean;
		isTapped?: boolean;
		alternatives?: Message['id'][];
		editMsdgId?: Message['id'] | null;
		isLast?: boolean;
		// The conversation's served model id, used by the provenance badge to name
		// the model honestly. routerMetadata.model (per-answer) wins when present;
		// this is the fallback since we serve a single model with no Omni routing,
		// so routerMetadata is usually empty.
		modelId?: string;
		// The open-stack gap this answer's originating prompt deliberately surfaces, if any
		// (resolved by ChatWindow from the preceding user prompt; see starterGaps). Drives the
		// honest "touches a gap → get involved" CTA. Undefined for prompts that target no gap.
		gap?: StarterGap;
		onretry?: (payload: { id: Message['id']; content?: string }) => void;
		onshowAlternateMsg?: (payload: { id: Message['id'] }) => void;
		// The user prompt this assistant answer responds to (resolved by ChatWindow from
		// the preceding message, like `gap`). Lets the user request an independent second
		// opinion on the same question. Undefined for user messages / no prior prompt.
		question?: string;
		// Highlight-to-reply: when the reader selects text inside an answer, a small "Quote"
		// affordance offers to drop the selection into the composer as a quoted block so the
		// next message is scoped to it. ChatWindow owns the draft, so it does the insert.
		onquote?: (text: string) => void;
		// Sends a message as the visitor. The low-resource notice ends by offering to try
		// anyway, and this is the button that takes the offer, so nobody has to type the reply. (CUR-1841)
		onsend?: (text: string) => void;
		// 1-indexed position of this message among the conversation's rendered turns (ChatWindow's
		// `{#each messages as message, idx}`). Analytics-only — carried down to the provenance/
		// disposition/report events that want a turn_number property.
		turnNumber?: number;
	}

	let {
		message,
		loading = false,
		isAuthor: _isAuthor = true,
		readOnly: _readOnly = false,
		isTapped = $bindable(false),
		alternatives = [],
		editMsdgId = $bindable(null),
		isLast = false,
		modelId,
		gap,
		question,
		onretry,
		onshowAlternateMsg,
		onquote,
		onsend,
		turnNumber
	}: Props = $props();

	// Honest response disposition — what the model's answer actually IS (a normal answer, or a self-decline
	// / capability-disclaimer / clarification it produced itself). One source ($lib/chat/utils/responseDisposition
	// via provenanceFacts) shared with the inline trace + the request-log view. Drives the DispositionNotice chip.
	let facts = $derived(provenanceFacts(message));
	let disposition = $derived(facts.disposition);
	// The answers Step by step offers a second opinion on (StepByStep.svelte), so the footer action
	// never opens XRAY onto a panel that isn't there.
	let secondOpinionOffered = $derived(facts.answered && !facts.declined && !facts.verified);

	// The model this answer was asked of (CUR-3234). An answer from before a mid-chat switch keeps the
	// model it was sent to; answers persisted before the field shipped fall back to the conversation's.
	let turnModelId = $derived(message.requestedModel ?? modelId);

	// Backup-lane serve, derived from served-vs-requested model ids (identity.ts servedByBackup).
	let servedByBackup = $derived(
		isServedByBackup(message.routerMetadata, turnModelId, message.failover)
	);

	// The model id the persistent badge below the answer names, if any (CUR-125, corrected — see
	// servedModelId's own comment for why a bare `.model` check suppressed the badge on the ordinary,
	// correctly-served case).
	// An answer a sync client wrote (CUR-4312) was not served here, so no Alpha model is named on it.
	// A turn a sync client wrote shows like Alpha's own; hovering it says where it came from and that
	// Alpha did not screen it.
	let syncedFrom = $derived(syncClientById(message.origin));
	let syncedTitle = $derived(
		syncedFrom ? m.chat_writtenInTitle({ app: syncedFrom.label }) : undefined
	);

	let badgeModelId = $derived(
		message.origin ? undefined : servedModelId(message.routerMetadata, turnModelId)
	);

	// Highlight-to-reply: a floating "Quote" affordance that appears over a text selection
	// inside this answer. Only meaningful for assistant answers and when a handler is wired.
	let quoteBtn = $state<{ top: number; left: number; text: string } | null>(null);

	function handleTextSelection() {
		if (!onquote || !contentEl) return;
		const sel = window.getSelection();
		const text = sel?.toString().trim() ?? '';
		// Require a real selection that lives INSIDE this answer's content.
		if (!sel || sel.isCollapsed || text.length < 2 || !contentEl.contains(sel.anchorNode)) {
			quoteBtn = null;
			return;
		}
		const rect = sel.getRangeAt(0).getBoundingClientRect();
		// Center the pill horizontally over the selection and float it just ABOVE; if the selection sits
		// near the top of the viewport, drop it just below instead so it never clips off-screen. `left` is
		// the selection's mid-point — the pill is translateX(-50%)'d onto it, so clamp by half its width.
		const centerX = rect.left + rect.width / 2;
		const above = rect.top > 48;
		quoteBtn = {
			top: above ? rect.top - 40 : rect.bottom + 8,
			left: Math.min(window.innerWidth - 52, Math.max(52, centerX)),
			text
		};
	}

	function doQuote() {
		if (!quoteBtn) return;
		onquote?.(quoteBtn.text);
		window.getSelection()?.removeAllRanges();
		quoteBtn = null;
	}

	// Dismiss the floating Quote pill on scroll or a click that starts elsewhere. The pill's own
	// mousedown stops propagation, so clicking it doesn't trip this. The mousedown listener is
	// armed on the next tick so the selection's own mouseup doesn't immediately clear the pill.
	$effect(() => {
		if (!quoteBtn) return;
		const clear = () => (quoteBtn = null);
		window.addEventListener('scroll', clear, true);
		const t = setTimeout(() => window.addEventListener('mousedown', clear), 0);
		return () => {
			clearTimeout(t);
			window.removeEventListener('scroll', clear, true);
			window.removeEventListener('mousedown', clear);
		};
	});

	// Additive crisis-resource card: if the prompt this answer responds to trips an unambiguous
	// self-harm signal, lead the reply with real help (src/lib/crisis.ts — client-side, stores nothing,
	// never blocks the model). Gated to assistant turns so it sits with the supportive response. A turn a
	// self-harm rule declined shows it too, since the server's verdict reaches wording this check misses (CUR-2111).
	const showCrisisResources = $derived(
		message.from === 'assistant' &&
			(message.moderation?.support === true || detectCrisisSignal(question))
	);

	// Honest-degradation surface: when a generation ended without a clean finish (user stop, or a
	// stream that died after partial tokens), say so over the preserved partial content rather than
	// letting it look complete. `error` is surfaced elsewhere; this is the `incomplete` state.
	// NOTE: showsInterruptedNotice is declared further down, beside hasNothingToShow — it depends on it,
	// and both need `blocks`, which is derived below.

	let contentEl: HTMLElement | undefined = $state();
	let isCopied = $state(false);
	let isUserMsgCopied = $state(false);
	let userCopyTimeout: ReturnType<typeof setTimeout>;
	// The footer's alternatives snippet shadows the `alternatives` prop inside AnswerFooter's children.
	const alternativeIds = $derived(alternatives);
	let lightboxSrc: string | null = $state(null);

	function handleContentClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (target.tagName === 'IMG' && target instanceof HTMLImageElement) {
			e.preventDefault();
			e.stopPropagation();
			lightboxSrc = target.src;
			return;
		}
		// The "?" superscript on a de-linked URL (urlGuard) is a button into its explanation: scroll to
		// the UrlNotice chip and flash it, so a curious click lands on the why rather than nowhere.
		if (target.closest('[data-uv-mark]')) {
			e.preventDefault();
			e.stopPropagation();
			openUrlNotice();
		}
	}

	// Keyboard activation for the focusable "?" marker (role=button) inside the rendered answer.
	function handleContentKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		if ((e.target as HTMLElement)?.closest?.('[data-uv-mark]')) {
			e.preventDefault();
			openUrlNotice();
		}
	}

	let urlNoticeEl: HTMLElement | undefined = $state();
	let urlNoticeFlash = $state(false);
	let urlNoticeFlashTimer: ReturnType<typeof setTimeout> | undefined;
	function openUrlNotice() {
		urlNoticeEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		urlNoticeFlash = true;
		clearTimeout(urlNoticeFlashTimer);
		urlNoticeFlashTimer = setTimeout(() => (urlNoticeFlash = false), 1600);
	}

	$effect(() => {
		// referenced to appease linter for currently-unused props
		void _isAuthor;
		void _readOnly;
	});
	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			editFormEl?.requestSubmit();
		}
		if (e.key === 'Escape') {
			refusedEdit.set(null);
			editMsdgId = null;
		}
	}

	function handleCopy(event: ClipboardEvent) {
		if (!contentEl) return;

		const selection = window.getSelection();
		if (!selection || selection.isCollapsed) return;
		if (!selection.anchorNode || !selection.focusNode) return;

		const anchorInside = contentEl.contains(selection.anchorNode);
		const focusInside = contentEl.contains(selection.focusNode);
		if (!anchorInside && !focusInside) return;

		if (!event.clipboardData) return;

		const range = selection.getRangeAt(0);
		const wrapper = document.createElement('div');
		wrapper.appendChild(range.cloneContents());

		// Before the attribute strip below, which removes the data-uv-mark this looks for.
		removeCopyNoise(wrapper);

		wrapper.querySelectorAll('*').forEach((el) => {
			el.removeAttribute('style');
			el.removeAttribute('class');
			el.removeAttribute('color');
			el.removeAttribute('bgcolor');
			el.removeAttribute('background');

			for (const attr of Array.from(el.attributes)) {
				if (attr.name === 'id' || attr.name.startsWith('data-')) {
					el.removeAttribute(attr.name);
				}
			}
		});

		const html = wrapper.innerHTML;
		const text = plainTextOf(wrapper);

		event.preventDefault();
		event.clipboardData.setData('text/html', html);
		event.clipboardData.setData('text/plain', text);
	}

	let editContentEl: HTMLTextAreaElement | undefined = $state();
	let editFormEl: HTMLFormElement | undefined = $state();

	// Zero-config reasoning autodetection: detect <think> blocks in content
	const THINK_BLOCK_REGEX = /(<think>[\s\S]*?(?:<\/think>|$))/gi;

	// Set when this answer is reported as not working in the person's language.
	let languageReported = $state(false);
	/** The visitor asked to hear an answer with no voice for its language in the English voice (CUR-3989). */
	let englishFallbackRequested = $state(false);

	// Strip think blocks and artifact tags for clipboard copy (always, regardless of detection)
	let contentWithoutThink = $derived.by(() =>
		stripArtifacts(message.content.replace(THINK_BLOCK_REGEX, '')).trim()
	);

	// The open-gap card and the footer's "How this was made" follow the language the visitor's browser
	// asks for (chromeCopy.ts, CUR-2394), like the live request log above them.
	const chromeLang = $derived(page.data.uiLang ?? 'en');

	// The passages search_past_chats returned, which ride in the turn's `rag` stamp. (CUR-4576)
	const pastChatSources = $derived((message.rag?.sources ?? []).filter((s) => s.engine === 'PastChat'));

	// Feed RAG + open-web sources to the markdown renderer so inline [n] citation markers become
	// links (addInlineCitations in utils/marked, which resolves [n] positionally as sources[n-1]).
	// The SERVER numbers community/RAG first ([1..k], maybeRagGrounding startAt=0) and continues the
	// open web at [k+1..] (runWebSearch startAt=communityCount, see conversation/[id]/+server.ts).
	// Order by the server-assigned `n`, NOT array position, so a link resolves to the same source the
	// model cited and the SourceStrip lists — and can't silently re-invert if retrieval order changes.
	let citationSources = $derived.by(() => {
		const rag =
			message.rag?.sources?.map((s) => ({ n: s.n, title: s.title, link: s.url ?? '' })) ?? [];
		const web =
			message.webSearch?.sources?.map((s) => ({ n: s.n, title: s.title, link: s.url ?? '' })) ?? [];
		// The visitor's own numbered sources hold [1]..[k] (visitorSources.ts, CUR-3844). With no title or
		// link, each renders as its own plain [n], never as a link to one of ours.
		const visitorCount = parseVisitorSources(question).length;
		const list = citationSourceList(visitorCount, [...rag, ...web]);
		// Cited pages are numbered first, in the order the answer cites them (CUR-3933); the renderer sees
		// one block at a time, so the order is read here from the whole answer. A visitor's own [1]..[k]
		// keep their numbers, so their answers are left in retrieval order.
		if (visitorCount) return list;
		const rank = new Map(citationOrder(message.content ?? '').map((n, i) => [n, i]));
		return list.map((s, i) => ({ ...s, citedRank: rank.get(i + 1) }));
	});

	type Block =
		| { type: 'text'; content: string }
		| { type: 'think'; content: string; closed: boolean }
		| { type: 'artifact'; op: ArtifactOperation; opIndex: number };

	type ProcessBlock = Extract<Block, { type: 'think' }>;

	type RenderUnit =
		| { kind: 'text'; content: string }
		| { kind: 'group'; blocks: ProcessBlock[] }
		| { kind: 'artifact'; op: ArtifactOperation; opIndex: number };

	// Expand any text block containing <think>…</think> into dedicated think blocks
	// so reasoning can be grouped/collapsed separately from the answer text.
	function expandThinkBlocks(input: Block[]): Block[] {
		const out: Block[] = [];
		for (const block of input) {
			if (block.type !== 'text') {
				out.push(block);
				continue;
			}
			for (const part of block.content.split(THINK_BLOCK_REGEX)) {
				if (!part) continue;
				if (part.startsWith('<think>')) {
					const closed = part.endsWith('</think>');
					out.push({ type: 'think', content: part.slice(7, closed ? -8 : undefined), closed });
				} else if (part.trim().length > 0) {
					out.push({ type: 'text', content: part });
				}
			}
		}
		return out;
	}

	// Replace inline <artifact> blocks in text with dedicated artifact blocks that
	// render as cards (content lives in the artifact panel). Streaming-safe:
	// partially received tags are hidden until complete.
	function expandArtifactBlocks(input: Block[]): Block[] {
		const out: Block[] = [];
		let opIndex = 0;
		for (const block of input) {
			if (block.type !== 'text') {
				out.push(block);
				continue;
			}
			for (const segment of splitArtifactSegments(block.content)) {
				if (segment.type === 'artifact') {
					out.push({ type: 'artifact', op: segment.op, opIndex: opIndex++ });
				} else if (segment.content.length > 0) {
					out.push({ type: 'text', content: segment.content });
				}
			}
		}
		return collapseConsecutiveArtifactOps(out);
	}

	// Models sometimes emit several back-to-back operations on the same artifact
	// (e.g. one update block per find/replace pair). Every op still becomes a
	// version in the registry, but showing a card per op clutters the chat —
	// keep only the last card of each consecutive run.
	function collapseConsecutiveArtifactOps(input: Block[]): Block[] {
		const out: Block[] = [];
		for (const block of input) {
			if (block.type === 'artifact') {
				let i = out.length - 1;
				while (i >= 0) {
					const prior = out[i];
					if (prior.type === 'text' && prior.content.trim().length === 0) {
						i -= 1;
						continue;
					}
					if (prior.type === 'artifact' && prior.op.identifier === block.op.identifier) {
						// Drop the earlier card (and the whitespace between) — this
						// later op supersedes it.
						out.splice(i, out.length - i);
					}
					break;
				}
			}
			out.push(block);
		}
		return out;
	}

	let blocks = $derived.by(() => {
		const updates = message.updates ?? [];
		const res: Block[] = [];
		let contentCursor = 0;
		let sawFinalAnswer = false;

		// Fast path: no updates at all
		if (updates.length === 0) {
			return expandArtifactBlocks(
				expandThinkBlocks(
					message.content ? [{ type: 'text' as const, content: message.content }] : []
				)
			);
		}

		for (const update of updates) {
			if (update.type === MessageUpdateType.Stream) {
				const token =
					typeof update.token === 'string' && update.token.length > 0 ? update.token : null;
				const len = token !== null ? token.length : (update.len ?? 0);
				const chunk =
					token ??
					(message.content ? message.content.slice(contentCursor, contentCursor + len) : '');
				contentCursor += len;
				if (!chunk) continue;
				const last = res.at(-1);
				if (last?.type === 'text') last.content += chunk;
				else res.push({ type: 'text' as const, content: chunk });
			} else if (update.type === MessageUpdateType.FinalAnswer) {
				sawFinalAnswer = true;
				const finalText = update.text ?? '';
				const currentText = res
					.filter((b) => b.type === 'text')
					.map((b) => (b as { type: 'text'; content: string }).content)
					.join('');
				const reconciliation = reconcileFinalAnswerText(currentText, finalText);

				if (reconciliation.type === 'append') {
					// Streamed text is a prefix of the final (identical on clean turns) — append
					// only the delta so the already-rendered blocks stay byte-stable (no re-parse,
					// no visual reflow at completion).
					const addedText = reconciliation.text;
					if (addedText) {
						const last = res.at(-1);
						if (last?.type === 'text') {
							last.content += addedText;
						} else {
							res.push({ type: 'text' as const, content: addedText });
						}
					}
				} else if (reconciliation.type === 'replace') {
					// The final text DIFFERS mid-stream — the server's post-hoc honesty guards
					// mutated it (dangling citations stripped, fabricated URLs de-linked, unbacked
					// source claims removed). FinalAnswer is authoritative (it is what persists and
					// what a reload renders), so REPLACE the accumulated text. This includes the
					// suffix-shaped case where a guard removed a bad prefix; keeping the streamed
					// text because it "ends with" the final answer leaks the very correction the
					// guard made. `res` holds only text blocks at this point (think/artifact
					// expansion happens below).
					res.length = 0;
					if (reconciliation.text) {
						res.push({ type: 'text' as const, content: reconciliation.text });
					}
				}
			}
		}

		// If content remains unmatched (e.g., persisted stream markers), append the remainder
		// Skip when a FinalAnswer already provided the authoritative text.
		if (!sawFinalAnswer && message.content && contentCursor < message.content.length) {
			const remaining = message.content.slice(contentCursor);
			if (remaining.length > 0) {
				const last = res.at(-1);
				if (last?.type === 'text') last.content += remaining;
				else res.push({ type: 'text' as const, content: remaining });
			}
		} else if (!res.some((b) => b.type === 'text') && message.content) {
			// Fallback: no text produced at all
			res.push({ type: 'text' as const, content: message.content });
		}

		return expandArtifactBlocks(expandThinkBlocks(res));
	});

	// A finished turn that produced NO answer has to say so. The failure this closes: a thinking model
	// opens <think>, reasons, never closes the tag and never writes an answer — so the
	// entire output is reasoning, every visible block is empty, and the turn would render as a finished
	// message with a blank body (CUR-113).
	//
	// Deliberately CAUSE-AGNOSTIC. It asks "did this finished turn leave the user with anything?", not
	// "was there an unclosed think tag" — so it equally covers an all-whitespace answer, a stream that
	// died before its first visible token, and whatever the next model does that we have not seen yet.
	//
	// Reads `blocks`, NOT contentWithoutThink: that derived also strips artifacts, so a message whose
	// entire answer IS an artifact would false-positive as empty. Reasoning does not count as an
	// answer — that is the whole point — so think blocks are not consulted.
	const hasNothingToShow = $derived(producedNoAnswer(blocks, message.files?.length ?? 0));

	// The gate lives in generationState.ts (shouldShowEmptyAnswerNotice) and checks `running`. `loading`
	// alone does not establish that a turn has FINISHED — it goes false when the fetch settles, a beat
	// (0.3-3.5s) before the final content reaches `blocks` — so on `loading` alone the notice would
	// announce "No answer was produced for this message." over turns that are mid-answer. LiveRequestLog
	// below is gated on `loading || status === 'running'`, and the notice must agree with it. Living in
	// a util rather than inline here lets it be tested, which a `$derived` inside a component with
	// this dependency tree cannot be.
	const showsEmptyAnswerNotice = $derived(
		shouldShowEmptyAnswerNotice({ message, noAnswer: hasNothingToShow, loading })
	);

	// The live request log's own gate. CUR-3557: its active line already reads "Making the audio…"
	// while the voice is made, so the in-message placeholder below stands down while it shows.
	const showsLiveLog = $derived(isLast && (loading || deriveMessageStatus(message) === 'running'));

	// The server holds ALIA's untagged reasoning back until its bare `</think>`, so the turn
	// has no content for 5-36 s. A held-reasoning status opens the reasoning panel for that wait; the
	// reasoning itself replaces it once released, as the opening `<think>` block of the content. (CUR-3942)
	const showsHeldReasoning = $derived(
		showsLiveLog &&
			!message.content.trim() &&
			(message.updates ?? []).some(
				(u) =>
					u.type === MessageUpdateType.Reasoning &&
					u.subtype === MessageReasoningUpdateType.Status &&
					u.status === HELD_REASONING_STATUS
			)
	);

	// An empty turn that was stopped (the visitor's Stop, or the stuck-generation watchdog;
	// both mark it interrupted) gets a line naming the stop. "No answer was produced" reads as a failure
	// when the visitor pressed Stop during "Working on it…". The wording names no actor, since the
	// watchdog sets the same flag. (CUR-2824)
	const stoppedBeforeAnswer = $derived(
		showsEmptyAnswerNotice && deriveMessageStatus(message) === 'incomplete'
	);

	// Honest-degradation surface: when a generation ended without a clean finish (user stop, or a
	// stream that died after partial tokens), say so over the preserved partial content rather than
	// letting it look complete. `error` gets its own notice below (CUR-1748); this is the
	// `incomplete` state — a clean stop with no failure status, not a break.
	//
	// Suppressed when the turn produced NOTHING — "the answer above may be cut off" is a false
	// statement when there is no answer above, and that is exactly the CUR-113 shape. Interrupted and
	// empty are mutually exclusive by construction, so the two notices can never both render.
	const showsInterruptedNotice = $derived(
		!loading && deriveMessageStatus(message) === 'incomplete' && !hasNothingToShow
	);

	// An `error` turn needs its own notice in the bubble (CUR-1748). Any compose-area treatment lives
	// outside the message bubble, and `showsEmptyAnswerNotice` and `showsInterruptedNotice` both
	// explicitly exclude `error` (see their own comments), so a watchdog-killed generation
	// (genTimeoutMs, ~45s) would leave this bubble with nothing. A timed-out turn sends an empty
	// `finalAnswer` and a `status:error` update with a real message ("The request took too long to
	// respond. Please try again."), so the text already exists; this puts it in the transcript. Same
	// honest-degradation shape as the two notices above, and the same fix: say what happened, over
	// whatever content did survive (a timeout can fire after real partial text already streamed).
	const errorNoticeMessage = $derived(
		[...(message.updates ?? [])]
			.reverse()
			.find(
				(update): update is Extract<typeof update, { type: MessageUpdateType.Status }> =>
					update.type === MessageUpdateType.Status && update.status === MessageUpdateStatus.Error
			)?.message
	);
	const showsErrorNotice = $derived(!loading && deriveMessageStatus(message) === 'error');
	// Each of the three notices carries its own Retry, so the footer drops its copy while one shows:
	// one Retry per turn, which offline-mid-answer and chat-message-send assert.
	// An input screen that didn't finish declines with "send it again"; its notice carries the
	// Retry for that, so the footer's icon drops here too. (CUR-3739)
	const showsUnscreenedNotice = $derived(!loading && !!message.moderation?.unscreened);
	const showsDegradationNotice = $derived(
		showsErrorNotice || showsInterruptedNotice || showsEmptyAnswerNotice || showsUnscreenedNotice
	);

	// The footer's provenance line. "Finished" is showsProvenanceReceipt, not `!loading` (CUR-1674),
	// with `loading` scoped to the last message so an earlier answer keeps its line while a newer turn
	// streams (CUR-1978). A fixed server string names no model (CUR-1579); a finished answer nothing
	// reported a model for says so rather than going silent (CUR-1606) — except on an errored turn,
	// where the error notice already settles it (CUR-2201).
	const receiptReady = $derived(showsProvenanceReceipt({ message, loading: isLast && loading }));
	const footerProvenance = $derived<'fixed' | 'unavailable' | undefined>(
		!receiptReady || message.moderation?.flagged
			? undefined
			: message.fixedReply
				? 'fixed'
				: !badgeModelId && deriveMessageStatus(message) !== 'error'
					? 'unavailable'
					: undefined
	);

	// Coalesce consecutive thinking blocks into groups so they can collapse into a
	// single "Thought" summary. Text passes through.
	let renderUnits = $derived.by(() => {
		const units: RenderUnit[] = [];
		let current: ProcessBlock[] | null = null;
		const flush = () => {
			if (current && current.length) {
				units.push({ kind: 'group', blocks: current });
			}
			current = null;
		};
		for (const block of blocks) {
			if (block.type === 'think') {
				(current ??= []).push(block);
			} else if (block.type === 'artifact') {
				flush();
				units.push({ kind: 'artifact', op: block.op, opIndex: block.opIndex });
			} else {
				flush();
				units.push({ kind: 'text', content: block.content });
			}
		}
		flush();
		return units;
	});

	// Still mid-process (thinking / calling tools, no answer yet) → render the
	// blocks flat like today. Once the final answer starts streaming the last
	// block becomes text, so this flips to false and the nested summary takes over.
	//
	// `loading` alone goes false a beat before the final content reaches `blocks` (same race
	// documented above `showsEmptyAnswerNotice`); a bare `!loading` would flip this to the nested branch
	// while `blocks` still holds only the streamed placeholder, leaving the header reading "Computed"
	// over a stale body. Treat the turn as still running until `deriveMessageStatus` agrees, as
	// LiveRequestLog does, not just until the client fetch settles. (CUR-903)
	let isProcessStreaming = $derived.by(() => {
		if (!isLast || !isTurnStillRunning(loading, message)) return false;
		const last = blocks.at(-1);
		return !!last && last.type === 'think';
	});

	$effect(() => {
		if (isCopied) {
			setTimeout(() => {
				isCopied = false;
			}, 1000);
		}
	});

	// Tailwind's `prose` resets font-size to 1rem while the app shell uses
	// `text-smd` (0.94rem); re-applying it here keeps answer text — and every
	// em-scaled child (code, pre, lists, tables, KaTeX) — in line with the rest
	// of the UI. Single source for both the streaming and final render branches. Heading sizes
	// (h1–h6, one distinct step each) live in styles/main.css under `.chat-answer`.
	const proseClasses =
		'chat-answer prose max-w-none text-smd dark:prose-invert prose-pre:bg-gray-800 prose-img:my-0 prose-img:cursor-pointer prose-img:rounded-lg';

	const embeddedDemo = getContext<boolean | undefined>('alpha:embedded-demo') ?? false;
	let editMode = $derived(editMsdgId === message.id);
	// Why the edit box refused to send, shown in the box itself. A refusal from the server
	// arrives through refusedEdit, which reopens this box with the text the person wrote. It is read
	// once with get() and cleared only when the person sends or closes the box, so a resync that
	// remounts this message reopens it the same way.
	// The box is filled once each time it opens, so the effect tracks only editMode and the textarea. A
	// later update to the message (a title arriving, the reload after a fast answer) must not write the
	// original text back over what the person is typing. (CUR-2825)
	let editRefusal = $state<string | null>(null);
	$effect(() => {
		const el = editContentEl;
		if (!editMode || !el) return;
		untrack(() => {
			const refused = get(refusedEdit);
			const mine = refused?.id === message.id ? refused : null;
			editRefusal = mine?.reason ?? null;
			el.value = mine?.text ?? message.content;
			el.focus();
		});
	});
	// Our own message limit's wait (CUR-3216) holds this box's Send as it holds the
	// composer's, and the box counts it down. ChatWindow clears the hold when the wait ends. (CUR-3410)
	let heldNow = $state(Date.now());
	const editHeldSeconds = $derived(
		editMode && $sendHeldUntil ? Math.max(0, Math.ceil(($sendHeldUntil - heldNow) / 1000)) : 0
	);
	$effect(() => {
		if (!editMode || !$sendHeldUntil) return;
		heldNow = Date.now();
		const timer = setInterval(() => (heldNow = Date.now()), 250);
		return () => clearInterval(timer);
	});
</script>

{#if message.from === 'assistant'}
	<div
		class="group relative flex w-full max-w-full items-start justify-start leading-relaxed"
		data-message-id={message.id}
		data-message-role="assistant"
		role="presentation"
		onclick={() => (isTapped = !isTapped)}
		onkeydown={() => (isTapped = !isTapped)}
	>
		<!-- Assistant identity ring intentionally hidden for now (single-agent transcript): the
		     LiveRequestLog's green pulse + "Apertus is working…" already mark the assistant, so a
		     static ring beside it is redundant. Restore <MessageAvatar/> here (and its import) if
		     multi-agent transcripts ever need a per-speaker marker. -->

		<div
			class="relative flex w-full min-w-0 flex-col gap-2 wrap-break-word text-fg-1 prose-pre:my-2"
			title={syncedTitle}
		>
			{#if showCrisisResources}
				<!-- Leads the reply: real help is the first thing a person in distress sees. -->
				<CrisisResources lang={message.moderation?.supportLang} country={message.moderation?.supportCountry} />
			{/if}
			{#if message.files?.length}
				<Attachment.Row aria-label="Attached files">
					{#each message.files as file (file.value)}
						<UploadedFile {file} canClose={false} />
					{/each}
				</Attachment.Row>
			{/if}

			<!-- LIVE request log — ABOVE the forming answer WHILE the turn is in flight: it reads like a
			     build log ("✓ searched 3 sources · ◐ Apertus is writing…"), the active line pulsing, and it
			     replaces the bare dots. When the turn ends it vanishes and the ProvenanceTrace receipt (below)
			     takes over. Gated message-intrinsically (running) so it also covers a fresh home→[id] nav. -->
			{#if showsLiveLog}
				<LiveRequestLog {message} modelId={turnModelId} />
			{/if}
			{#if showsHeldReasoning}
				<div data-exclude-from-copy data-testid="held-reasoning" class="mb-1">
					<OpenReasoningResults content={m.message_reasoningHeld()} loading />
				</div>
			{/if}

			<!-- This is a content region, not a widget: the handlers are progressive enhancements
			     (copy, link clicks, text selection) over the answer; keyboard users operate the real
			     controls inside it, so a static-interaction role would mislead AT users. The companion
			     a11y_click_events_have_key_events is already satisfied by onkeydown below. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				bind:this={contentEl}
				oncopy={handleCopy}
				onclick={handleContentClick}
				onkeydown={handleContentKeydown}
				onmouseup={handleTextSelection}
			>
				{#if isProcessStreaming}
					<!-- Streaming the thinking phase: render every block flat and
					     inline. Nesting kicks in once the answer starts. -->
					{#each blocks as block, blockIndex (`block-${blockIndex}`)}
						{#if block.type === 'text'}
							{#if block.content.trim().length > 0}
								<div class={proseClasses}>
									<MarkdownRenderer
										content={fixAcronymExpansions(block.content)}
										sources={citationSources}
										loading={isLast && loading}
									/>
								</div>
							{/if}
						{:else if block.type === 'artifact'}
							<ArtifactCard op={block.op} messageId={message.id} opIndex={block.opIndex} />
						{:else}
							<div data-exclude-from-copy class="not-last:mb-1 has-[+.prose]:mb-2! [.prose+&]:mt-3">
								<OpenReasoningResults
									content={block.content}
									loading={isLast && loading && !block.closed}
									unrunReason={message.unrunCode?.reason}
								/>
							</div>
						{/if}
					{/each}
				{:else}
					<!-- Answer started or generation finished: nest the process blocks. -->
					{#each renderUnits as unit, unitIndex (`${unit.kind}-${unitIndex}`)}
						{#if unit.kind === 'text'}
							<!-- Empty text unit while loading: the LiveRequestLog above already carries the single
							     labeled live indicator ("Apertus is thinking…/writing…"), so we DON'T render a
							     second bare IconLoading dot here — two stacked pulsing dots for the same wait read
							     as noise. LiveRequestLog is guaranteed visible in this window (it shows whenever
							     isLast && loading), so dropping this leaves no gap. -->
							{#if unit.content.trim().length > 0}
								<div class={proseClasses}>
									<MarkdownRenderer
										content={fixAcronymExpansions(unit.content)}
										sources={citationSources}
										loading={isLast && loading}
									/>
								</div>
							{/if}
						{:else if unit.kind === 'artifact'}
							<ArtifactCard op={unit.op} messageId={message.id} opIndex={unit.opIndex} />
						{:else if unit.kind === 'group'}
							<div data-exclude-from-copy class="not-last:mb-1 has-[+.prose]:mb-2! [.prose+&]:mt-3">
								{#each unit.blocks as only, onlyIndex (`think-${onlyIndex}`)}
									<OpenReasoningResults
										content={only.content}
										loading={false}
										unrunReason={message.unrunCode?.reason}
									/>
								{/each}
							</div>
						{/if}
					{/each}
				{/if}
			</div>

			<!-- Open-component audio (TTS) as a structured editorial player, not a raw markdown <audio>:
			     matches the paper/ink design, and a stable element so autoplay isn't torn down by a markdown
			     re-render. Surfaced from message.mcp.audio; the spoken text is the message body above.
			     Held until the turn finishes: a read-aloud turn keeps its text back to the end, so a clip can
			     land first, and a play button under an empty reply still saying "Making the audio…" offered
			     audio for an answer nobody could see yet (CUR-2048). -->
			{#if page.data.readAloudEnabled && message.mcp?.audio && !(isLast && isTurnStillRunning(loading, message))}
				<div data-exclude-from-copy>
					<MediaAudioPlayer src={message.mcp.audio} />
					{#if message.mcp.voice}
						<!-- The language has regional variants and the voice speaks one of them (CUR-3989). -->
						<p class="mt-1 type-small text-fg-3" data-read-aloud-voice>
							{m.message_readAloudVoice({ voice: message.mcp.voice })}
						</p>
					{/if}
				</div>
			{:else if page.data.readAloudEnabled && $synthesizingAudioFor === message.id && !showsLiveLog}
				<!-- Audio is being synthesized but hasn't arrived yet (the TTS Space can cold-start). Show an
				     in-message warming placeholder where the player will appear, escalating to a cold-start note
				     past the warm threshold, instead of a silent gap that reads as broken. -->
				<div data-exclude-from-copy>
					<WarmingIndicator
						active={true}
						label={m.message_voicePreparing()}
						warmingLabel={m.message_voiceWarming()}
						coldThresholdS={3}
					/>
				</div>
			{:else if message.mcp?.skipped}
				<!-- Honest cold-start surface: an open component (the TTS voice, or a tool) was cold and didn't
				     respond in time, so the answer is shown without it. Visible IN the message — not just the
				     collapsed trace — because a silent miss reads as broken. Amber = degraded, not an error.
				     CUR-2268: said in what the visitor lost, not in backend words. The one configured Space is
				     the read-aloud voice, so with read-aloud on the skip is the audio. -->
				<div data-exclude-from-copy data-mcp-skipped>
					<span
						class="inline-flex items-center gap-1.5 text-[length:var(--ap-text-2)] text-[var(--ap-ink-3)]"
					>
						<span class="relative -top-px size-[6px] shrink-0 rounded-full bg-[var(--ap-building)]"
						></span>
						<span
							>{message.mcp.unsupportedLanguage
								? m.message_readAloudUnsupported({ language: message.mcp.unsupportedLanguage })
								: message.mcp.failed
									? page.data.readAloudEnabled
										? m.message_readAloudFailed()
										: m.message_toolFailed()
									: page.data.readAloudEnabled
										? m.message_readAloudSkipped()
										: m.message_toolSkipped()}</span
						>
					</span>
					{#if page.data.readAloudEnabled && message.mcp.unsupportedLanguage && message.mcp.fallbackAudio}
						<!-- No voice for this language: the English voice reads it only when asked, since a wrong
						     accent played unasked is the failure read-aloud avoids (CUR-3989). -->
						{#if englishFallbackRequested}
							<div class="mt-2">
								<MediaAudioPlayer src={message.mcp.fallbackAudio} />
							</div>
						{:else}
							<Button
								variant="secondary"
								size="xs"
								casing="sentence"
								class="mt-2"
								data-read-aloud-english
								onclick={() => {
									englishFallbackRequested = true;
									// Asking for the English voice is asking to hear it: start it inside this tap
									// rather than mount a player that waits for a second one.
									if (message.mcp?.fallbackAudio) void playOnTap(message.mcp.fallbackAudio).catch(() => {});
								}}
								>{m.message_readAloudInEnglish()}</Button
							>
						{/if}
					{/if}
				</div>
			{/if}

			<!-- Shared shape for every honest-degradation notice below: role="alert"/aria-live so screen
			     readers announce it, retry through the same regenerate path. Three call sites (interrupted,
			     empty-answer, error) differ only in their guard and their copy, so the markup is one snippet (CUR-1748). -->
			{#snippet degradationNotice(text: string, statusLink = false)}
				<div
					role="alert"
					aria-live="polite"
					data-exclude-from-copy
					class="mt-2 type-body text-fg-3"
				>
					{text}{#if onretry}<button
							type="button"
							class="ml-1 underline underline-offset-2 transition-control hover:text-fg-1"
							onclick={() => onretry?.({ id: message.id })}>{m.message_retry()}</button
						>{/if}{#if statusLink}<a
							href="https://status.aipotluck.org"
							target="_blank"
							rel="noreferrer"
							class="ml-3 inline-flex items-center gap-0.5 underline underline-offset-2 transition-control hover:text-fg-1"
							><RiArrowUpRight
								class="size-3.5 shrink-0"
								aria-hidden="true"
							/>{m.message_statusPage()}</a
						>{/if}
				</div>
			{/snippet}

			<!-- Honest "incomplete" notice: the generation was interrupted (user stop, or a stream that
			     died after partial tokens), so the answer above may be cut off. -->
			{#if showsInterruptedNotice}
				{@render degradationNotice(m.message_interrupted())}
			{/if}

			<!-- The turn finished having produced no answer at all (reasoning-only output, an empty
			     stream, whitespace). Saying nothing here leaves a blank bubble that reads as a bug or, worse,
			     as the model having nothing to say. See hasNothingToShow (CUR-113). An answer that came back
			     empty without the visitor stopping it points at the status page too (CUR-4062). -->
			{#if showsEmptyAnswerNotice}
				{@render degradationNotice(
					stoppedBeforeAnswer ? m.message_stoppedBeforeAnswer() : m.message_noAnswer(),
					!stoppedBeforeAnswer
				)}
			{/if}

			<!-- CUR-1748: the turn ended with an explicit error (a watchdog kill, a capacity limit, a
			     dependency failure) rather than a clean finish. A timeout can fire after real text already
			     streamed, so this does not require hasNothingToShow the way the empty-answer notice does.
			     Uses the update's own message so the copy stays accurate to what actually happened ("took
			     too long", "at capacity", etc.) rather than one generic string for every cause. -->
			<!-- CUR-3739: the decline above already says why, so the notice is just its Retry, which
			     regenerates the stored turn with its photo or file. -->
			{#if showsUnscreenedNotice}
				{@render degradationNotice('')}
			{/if}

			{#if showsErrorNotice}
				<!-- CUR-2201: a failed turn is the moment someone wonders whether Alpha is down, so the
				     notice points at the status page beside Retry. -->
				{@render degradationNotice(errorNoticeMessage ?? m.message_somethingWrong(), true)}
			{/if}

			<!-- CUR-2273: the expressions the model sent to the calculate tool and what code got for each,
			     directly under the answer so the setup behind a number can be read. Live as well as after
			     the turn: each expression lands before the model writes the sentence that uses it. -->
			{#if message.calculations?.length}
				<CalculationNote calculations={message.calculations} />
			{/if}

			<!-- Starter-cache honesty chip: this turn was served from a pre-vetted starter
			     because the live request never reached the server, so the provenance trace below
			     describes the pipeline this answer did NOT run. Render it above the trace to
			     qualify it. Transient (message.servedFromCache) — gone on reload. -->
			{#if showsCacheNotice(message)}
				<CacheNotice {message} {onretry} />
			{/if}

			<!-- The detailed provenance (the step-by-step trace, the served-model badge, the second-opinion
			     action) moved into XRAY — one "How this was made" link in the footer below opens it on this
			     answer. A safety decline still shows inline: it changes what the answer IS, so it can't hide
			     behind a link. -->
			{#if showsProvenanceReceipt( { message, loading: isLast && loading } ) && message.moderation?.flagged}
				<SafetyBadge
					kind={message.moderation.kind}
					ruleLabel={message.moderation.ruleLabel}
					unscreened={message.moderation.unscreened}
				/>
				<!-- CUR-3902: a policy decline can be challenged. Not a self-harm reply, which offers support
				     rather than a limit, and not an unscreened hold, which declined nothing. A child-safety
				     decline keeps it: a false positive there needs a person most of all, and the reviewer
				     already sees the stored conversation, so the note adds little. -->
				{#if !message.moderation.support && !message.moderation.unscreened && !embeddedDemo}
					<DeclineChallenge messageId={message.id} />
				{/if}
			{/if}

			<!-- Honest response disposition: the model RAN and produced something that isn't a clean answer
			     (it declined on its own / stated a limit about itself / asked for clarification). Naming it
			     keeps the provenance from reading as a normal answer. NOT a safety-layer block (that's
			     moderation, below) — the model did this itself. -->
			{#if disposition !== 'answered' && !loading}
				<DispositionNotice {disposition} {turnNumber} />
			{/if}

			<!-- Honest name-adoption correction: the post-generation guard caught the model taking on a
			     personal name this turn (prompt rules don't reliably stop it). The chip states plainly the
			     system has no name; the server also strips the name from later context. -->
			{#if message.nameNotice && !loading}
				<NameNotice name={message.nameNotice.name} />
			{/if}

			<!-- Non-blocking safety advisory (Coop "notice" tier): the pre-screen flagged this turn for a
			     category that warrants an honest notice but NOT a decline, so the answer above is real. The
			     chip states why the turn was noticed. Renders only when the pre-screen sets `message.safetyNotice`. -->
			{#if message.safetyNotice && !loading}
				<SafetyNotice message={message.safetyNotice.message} />
			{/if}

			<!-- CUR-4384: the model Auto chose first never started, so Auto asked another; say so on the answer. -->
			{#if message.autoRoute?.repickedFrom}
				<div data-auto-repicked>
					<AnswerNote
						icon={RiRouteLine}
						tone="info"
						title={m.routing_repicked({
							from: catalogName(message.autoRoute.repickedFrom),
							to: catalogName(message.autoRoute.model)
						})}
					/>
				</div>
			{/if}

			<!-- CUR-2382: the files sent with this turn could not be scanned, so none was stored. -->
			{#if message.attachmentNotice && !loading}
				<AttachmentNotice message={message.attachmentNotice.message} />
			{/if}

			<!-- CUR-3291: a stored file could not be read back this turn, so the answer did not use it. -->
			{#if message.unreadFilesNotice && !loading}
				<AttachmentNotice message={message.unreadFilesNotice} detail={null} />
			{/if}

			<!-- CUR-4091: a web search ran and didn't finish, so the answer was written without web sources. -->
			{#if message.searchAttempt?.failed && !message.webSearch && !loading}
				<SearchUnfinishedNotice />
			{/if}

			<!-- CUR-2830: Agent was on Auto and the route check failed, so the selected model answered. -->
			{#if message.agentRouteFailed && !loading}
				<AgentRouteNotice />
			{/if}

			<!-- CUR-4576: the answer searched the person's own earlier chats; the note names each one. -->
			{#if pastChatSources.length && !loading}
				<PastChatsNotice sources={pastChatSources} />
			{/if}

			<!-- CUR-2893: older exchanges were left out so the chat fit the model's context. -->
			{#if message.historyLeftOut && !loading}
				<HistoryNotice />
			{/if}

			<!-- Write-permission advisory (CUR-471): the agent's writes were resolved to deny_writes for
			     this turn (most often a new/staged account still accruing trust). The answer above is
			     still real — this just explains a capability the turn didn't have. -->
			{#if message.writePolicy && !loading}
				<WritePolicyNotice
					tier={message.writePolicy.tier}
					tasksDone={message.writePolicy.tasksDone}
					tasksRequired={message.writePolicy.tasksRequired}
				/>
			{/if}

			<!-- Agent confirmation gate (CUR-218): deliberately NOT gated on `!loading` like every notice
			     here — a paused tool call needs a real human answer inside agent-service's own timeout
			     window, which is now, not after the turn finishes. Renders once per open/resolved entry
			     (a turn can pause more than once). -->
			{#if message.agentConfirmations?.length}
				{#each message.agentConfirmations as confirmation (confirmation.confirmId)}
					<AgentConfirmPrompt
						conversationId={page.params.id ?? ''}
						taskId={confirmation.taskId}
						confirmId={confirmation.confirmId}
						kind={confirmation.kind}
						title={confirmation.title}
						summary={confirmation.summary}
						plain={confirmation.plain}
						decision={confirmation.decision}
						reason={confirmation.reason}
						deadlineAt={confirmation.deadlineAt}
						channel={confirmation.channel}
					/>
				{/each}
			{/if}

			<!-- Unverified-link advisory: the post-generation URL guard de-linked citation URLs we couldn't
			     vouch for. The answer above renders them as non-navigating "?"-marked references; this chip
			     is where those superscripts point the eye for the why. -->
			{#if message.urlNotice && !loading}
				<div bind:this={urlNoticeEl}>
					<UrlNotice
						count={message.urlNotice.count}
						urls={message.urlNotice.urls}
						flash={urlNoticeFlash}
					/>
				</div>
			{/if}

			<!-- Honest "touches an open gap → get involved" CTA. Only when this turn's prompt
			     deliberately surfaces a known gap (starterGaps) and the answer actually ran —
			     never on a safety decline (no answer to attach a gap to). -->
			{#if gap && !loading && message.content && !message.moderation?.flagged}
				<GapInvite {gap} lang={chromeLang} />
			{/if}

			<!-- CUR-1841: the low-resource notice offers to try anyway. Retry would only bring the same notice
			     back, so this sends the visitor's yes, and the server answers the next turn with an attempt. -->
			{#if onsend && isLast && !loading && message.fixedReply?.kind === 'low-resource-language'}
				<div class="pt-2">
					<Button
						variant="secondary"
						size="xs"
						casing="sentence"
						data-try-anyway
						onclick={() => onsend?.(chromeCopy(chromeLang).tryAnywayMessage)}
						>{chromeCopy(chromeLang).tryAnyway}</Button
					>
				</div>
			{/if}

			<!-- `loading` is the page's flag for whichever turn is live, so it is scoped to the last message:
			     an earlier answer keeps its footer (and its provenance line) while a newer turn streams (CUR-1978). -->
			{#if servingRecorded(message.routerMetadata) || (!(isLast && loading) && message.content)}
				<AnswerFooter
					messageId={message.id}
					modelId={receiptReady && !message.fixedReply && !message.moderation?.flagged
						? badgeModelId
						: undefined}
					provenance={footerProvenance}
					backup={servedByBackup}
					provider={message.routerMetadata?.provider}
					backend={message.routerMetadata?.backend}
					verifyMethod={message.routerMetadata?.verifyMethod}
					content={contentWithoutThink}
					lang={chromeLang}
					showActions={!isLast || !isTurnStillRunning(loading, message)}
					onretry={showsDegradationNotice ? undefined : () => onretry?.({ id: message.id })}
					secondOpinion={secondOpinionOffered}
				>
					{#snippet report()}
						<!-- Report a problem — on every completed answer; the Terms page points here.
						     Not in the /alpha demo: its answers are samples, not Alpha's to be reported. -->
						{#if !embeddedDemo}<ReportButton
								messageId={message.id}
								{turnNumber}
								onreported={(reason) => {
									if (reason === 'language') languageReported = true;
								}}
							/>{/if}
					{/snippet}
					{#snippet alternatives()}
						{#if alternativeIds.length > 1 && editMsdgId === null}
							<Alternatives
								{message}
								alternatives={alternativeIds}
								{loading}
								onshowAlternateMsg={(payload) => onshowAlternateMsg?.(payload)}
							/>
						{/if}
					{/snippet}
				</AnswerFooter>
			{:else if alternativeIds.length > 1 && editMsdgId === null && !(isLast && loading)}
				<!-- A failed retry has no text and no routing record, so the footer above stays hidden. The
				     switcher still has to show, or the earlier answers become unreachable. -->
				<div class="flex justify-end pt-1 text-fg-3">
					<Alternatives
						{message}
						alternatives={alternativeIds}
						{loading}
						onshowAlternateMsg={(payload) => onshowAlternateMsg?.(payload)}
					/>
				</div>
			{/if}

			<!-- After "It didn't work in my language": the data call-to-action, once per conversation. -->
			{#if languageReported && page.params.id}
				<LanguageReportNote
					conversationId={page.params.id}
					text={question || contentWithoutThink}
				/>
			{/if}
		</div>
	</div>
	{#if lightboxSrc}
		<ImageLightbox src={lightboxSrc} onclose={() => (lightboxSrc = null)} />
	{/if}
{/if}
{#if message.from === 'user'}
	<div
		class="group relative w-full items-start justify-start gap-4"
		data-message-id={message.id}
		data-message-type="user"
		role="presentation"
		onclick={() => (isTapped = !isTapped)}
		onkeydown={() => (isTapped = !isTapped)}
	>
		<!-- Sent messages are RIGHT-aligned in a filled bubble; the assistant's reply is the
		     left-aligned outlined card. Filled-right (sent) vs outlined-left (received) is the
		     spatial grammar every first-in-class chat uses — and fixes the old inversion where the
		     user's plain text started further LEFT than the reply. Edit mode stays full-width. -->
		<div class="flex w-full flex-col items-end gap-2" title={syncedTitle}>
			{#if message.files?.length}
				<Attachment.Row aria-label="Attached files" class="w-auto max-w-full">
					{#each message.files as file (file.value)}
						<UploadedFile {file} canClose={false} />
					{/each}
				</Attachment.Row>
			{/if}
			{#if message.leftOutFiles?.length}
				<div class="flex w-fit flex-wrap justify-end gap-4">
					{#each message.leftOutFiles as file, i (i)}
						<LeftOutFile name={file.name} mime={file.mime} />
					{/each}
				</div>
			{/if}

			<div class="flex w-full flex-row flex-nowrap justify-end">
				{#if !editMode}
					<!-- The bubble reads the way most of its letters do, so an Arabic, Urdu or Pashto question
					     reads right to left with its question mark at the end, even when it opens with a
					     Latin name (CUR-1917, textDirection.ts). -->
					<p
						dir={textDirection(message.content)}
						class="w-fit max-w-4/5 rounded-sharp bg-surface-3 px-4 py-2.5 text-wrap wrap-break-word whitespace-break-spaces text-fg-1"
					>
						{message.content.trim()}
					</p>
				{:else}
					<!-- Editing happens in the bubble itself: same surface and corners, the text becomes editable,
					     and the two actions sit inside it. Enter sends, Escape cancels (handleKeyDown). -->
					<form
						class="flex w-full max-w-4/5 flex-col gap-2 rounded-sharp bg-surface-3 px-4 pt-2.5 pb-2 ring-2 ring-line-3"
						bind:this={editFormEl}
						data-editing-bubble
						onsubmit={(e) => {
							e.preventDefault();
							// Ctrl+Enter's requestSubmit() ignores the disabled Send, so the hold is checked here too.
							if (editHeldSeconds > 0) return;
							refusedEdit.set(null);
							const content = editContentEl?.value;
							// Refuse an over-long edit here, with the server's own words, as the composer
							// does (CUR-1921). Sending would close this box and the server's 400 would put the text in the main
							// composer, where Send makes a new message instead of a new version of this one. (CUR-2825)
							const limit = page.data.messageLengthLimit;
							if (typeof limit === 'number' && limit > 0 && (content?.length ?? 0) > limit) {
								editRefusal = messageTooLongMessage(content?.length ?? 0, limit);
								return;
							}
							onretry?.({ content, id: message.id });
							editMsdgId = null;
						}}
					>
						<textarea
							class="field-sizing-content max-h-80 min-h-6 w-full resize-none bg-transparent wrap-break-word whitespace-break-spaces text-fg-1 outline-none"
							dir="auto"
							aria-label={m.message_editYourMessage()}
							bind:this={editContentEl}
							value={message.content.trim()}
							onkeydown={handleKeyDown}
							required></textarea>
						<div class="flex items-center gap-2">
							{#if editHeldSeconds > 0}
								<span class="mr-auto flex items-center gap-1 type-caption text-fg-1" role="status"
									><RiErrorWarningLine
										aria-hidden="true"
									/>{`You can send again in ${editHeldSeconds} ${editHeldSeconds === 1 ? 'second' : 'seconds'}.`}</span
								>
							{:else if editRefusal}
								<span class="mr-auto flex items-center gap-1 type-caption text-fg-1" role="alert"
									><RiErrorWarningLine aria-hidden="true" />{editRefusal}</span
								>
							{:else}
								<span class="mr-auto type-caption text-fg-3">{m.message_editingHint()}</span>
							{/if}
							<Button
								variant="secondary"
								size="xs"
								casing="sentence"
								onclick={() => {
									refusedEdit.set(null);
									editMsdgId = null;
								}}>{m.message_cancel()}</Button
							>
							<Button
								type="submit"
								variant="primary"
								size="xs"
								casing="sentence"
								disabled={loading || editHeldSeconds > 0}>{m.message_send()}</Button
							>
						</div>
					</form>
				{/if}
			</div>
			<!-- Edit / Copy sit just below the bubble, inset from its corner, each on a solid chip so they
			     stay legible. They stay in the layout and the tab order, fading in on hover, when the
			     message holds focus, and always on a touch screen, where there is no hover (CUR-1849).
			     The row is in the flow, not pinned over the bubble's bottom edge, so nothing is drawn on
			     the message (CUR-4264); its height is reserved even while hidden or streaming, so the
			     conversation does not jump when the buttons come back. -->
			<div class="flex min-h-6 w-full items-center justify-end gap-1 pr-3">
				{#if alternatives.length > 1 && editMsdgId === null}
					<Alternatives
						{message}
						{alternatives}
						{loading}
						onshowAlternateMsg={(payload) => onshowAlternateMsg?.(payload)}
					/>
				{/if}
				{#if (alternatives.length > 1 && editMsdgId === null) || (!loading && !editMode)}
					<button
						class="flex h-6 cursor-pointer items-center gap-1 rounded-sharp border border-line-2 bg-surface-2 px-2 type-caption text-fg-2 opacity-0 shadow-popover group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-surface-3 hover:text-fg-1 pointer-coarse:opacity-100 [&_svg]:size-3.5"
						title={m.message_edit()}
						type="button"
						onclick={() => {
							if (requireAuthUser()) return;
							editMsdgId = message.id;
						}}
					>
						<RiPencil />
						{m.message_edit()}
					</button>
					<button
						class="flex h-6 cursor-pointer items-center gap-1 rounded-sharp border border-line-2 bg-surface-2 px-2 type-caption opacity-0 shadow-popover group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-surface-3 pointer-coarse:opacity-100 [&_svg]:size-3.5 {isUserMsgCopied
							? 'text-positive-text'
							: 'text-fg-2 hover:text-fg-1'}"
						title={m.message_copyToClipboard()}
						type="button"
						onclick={async () => {
							try {
								if (window.isSecureContext && navigator.clipboard) {
									await navigator.clipboard.writeText(message.content);
								} else {
									const textArea = document.createElement('textarea');
									textArea.value = message.content;
									document.body.appendChild(textArea);
									textArea.focus();
									textArea.select();
									document.execCommand('copy');
									document.body.removeChild(textArea);
								}
								isUserMsgCopied = true;
								clearTimeout(userCopyTimeout);
								userCopyTimeout = setTimeout(() => {
									isUserMsgCopied = false;
								}, 1000);
							} catch (err) {
								console.error('Failed to copy:', err);
							}
						}}
					>
						{#if isUserMsgCopied}
							<RiCheck class="scale-[0.85]" />
							{m.message_copied()}
						{:else}
							<RiFileCopy class="scale-[0.85]" />
							{m.message_copy()}
						{/if}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Highlight-to-reply: floating pill over a text selection inside this answer. mousedown
     preventDefault keeps the selection alive through the click; stopPropagation keeps the
     window dismiss-handler from firing for this same click. -->
{#if quoteBtn}
	<button
		type="button"
		class="fixed z-40 flex items-center gap-1 rounded-full border border-[var(--ap-rule)] bg-[var(--ap-paper)] px-2.5 py-1 text-[length:var(--ap-text-2)] font-medium text-[var(--ap-ink-2)] shadow-[var(--shadow-card)] transition-colors hover:border-[var(--ap-ink-3)] hover:bg-[var(--ap-paper-2)] hover:text-[var(--ap-ink)]"
		style="top: {quoteBtn.top}px; left: {quoteBtn.left}px; transform: translateX(-50%);"
		onmousedown={(e) => {
			e.preventDefault();
			e.stopPropagation();
		}}
		onclick={doQuote}
	>
		<RiDoubleQuotesL class="size-3" />
		{m.message_quote()}
	</button>
{/if}

<style>
	@keyframes loading {
		to {
			stroke-dashoffset: 122.9;
		}
	}
</style>
