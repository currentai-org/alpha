<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import { Tooltip } from '@aipotluck/alpha-ds';
	import { catalogBaseOf, catalogByGatewayId, orgs } from '$lib/chat/routing/catalog';
	import { resolveModelIdentity } from '$lib/chat/identity';
	import { provenanceLine } from '$lib/chat/provenanceLine';
	import { chromeCopy } from '$lib/chat/chromeCopy';
	import { m } from '$lib/paraglide/messages.js';
	import { stackOpen, xrayMessageId, xraySecondOpinion } from '$lib/chat/stores/stack';
	import { weakSpotsOpen } from '$lib/chat/stores/weakSpots';
	import { useShowServing } from '$lib/chat/stores/showServing.svelte';
	import OrgLogo from './OrgLogo.svelte';
	import RiFileCopyLine from '~icons/ri/file-copy-line';
	import RiCheckLine from '~icons/ri/check-line';
	import RiErrorWarningLine from '~icons/ri/error-warning-line';
	import { CopyFeedback } from '$lib/chat/utils/copyFeedback.svelte';
	import RiRefreshLine from '~icons/ri/refresh-line';
	import RiScan2Line from '~icons/ri/scan-2-line';
	import RiQuestionLine from '~icons/ri/question-line';
	import RiTeamLine from '~icons/ri/team-line';

	/**
	 * The line under every answer, in plain words: who made the model that answered (with their
	 * logo), and one "How this was made" link that opens XRAY on THIS answer — the receipt, the
	 * step-by-step trace and the second-opinion action live there. Then the everyday actions: copy,
	 * try again, report, and switching between alternative answers.
	 *
	 * Identity honesty is unchanged from ProvenanceBadge: `modelId` is the served id
	 * (`servedModelId`), a failover lane is named "(backup)", and a turn with no router signal at all
	 * passes no id — then no model is named, and `provenance` says why instead of going silent:
	 * `fixed` for a reply the server wrote as a fixed string (no model ran, CUR-1579), `unavailable`
	 * for a finished answer nothing reported a model for (CUR-1606).
	 */
	let {
		messageId,
		modelId,
		backup = false,
		provider,
		backend,
		verifyMethod,
		provenance,
		content,
		showActions = true,
		onretry,
		report,
		alternatives,
		secondOpinion = false,
		lang = 'en'
	}: {
		messageId: string;
		modelId?: string;
		backup?: boolean;
		/** The routing record for this turn (routerMetadata), for the full provenance line. */
		provider?: string;
		backend?: string;
		verifyMethod?: string;
		/** Why no model is named, when none is. */
		provenance?: 'fixed' | 'unavailable';
		/** Answer text for Copy (reasoning excluded). */
		content: string;
		/** False while the answer is still streaming. */
		showActions?: boolean;
		onretry?: () => void;
		report?: Snippet;
		alternatives?: Snippet;
		/** True when Step by step offers a second opinion on this answer, so the action can open it. */
		secondOpinion?: boolean;
		/** The answer's language (chromeCopy.ts), for its captions and the "How this was made" link. */
		lang?: string;
	} = $props();

	// The person may hide which model answered and where it ran; the X-ray link stays. (CUR-549)
	const serving = useShowServing();
	const model = $derived(catalogByGatewayId(modelId));
	// A reasoning variant has no catalog entry of its own; its maker is its base checkpoint's (CUR-1873).
	const base = $derived(catalogBaseOf(modelId));
	const maker = $derived(base ? orgs[base.maker] : undefined);
	const identity = $derived(modelId ? resolveModelIdentity(modelId) : undefined);
	// The exact model ("Apertus 1.5 70B"), not its family: two Apertus sizes serve side by side.
	const name = $derived(model?.name ?? identity?.short);
	const makerName = $derived(maker?.name ?? identity?.makerShort);

	// A refused copy says so on the control instead of looking like nothing happened (CUR-2823).
	const feedback = new CopyFeedback(1600);
	const copyState = $derived(feedback.state);
	onDestroy(() => feedback.dispose());
	const copyLabel = $derived(
		copyState === 'copied'
			? m.message_copied()
			: copyState === 'failed'
				? m.message_copyFailed()
				: m.message_copyToClipboard()
	);
	async function copy() {
		await feedback.copy(content);
	}

	// A disclosure for XRAY on THIS answer: expanded while the panel shows this message, so a second tap
	// closes it. Keyed by message id, so an answer the page remounts under a new id reads as collapsed.
	// One full sentence per shape, so each language orders the model, maker and backup note itself.
	// With the model and host hidden, the label names neither. (CUR-549)
	const howMadeLabel = $derived(
		!serving.current
			? chromeCopy(lang).howMade
			: makerName
				? backup
					? m.message_howMadeByBackup({ model: name ?? '', maker: makerName })
					: m.message_howMadeBy({ model: name ?? '', maker: makerName })
				: backup
					? m.message_howMadeBackup({ model: name ?? '' })
					: m.message_howMade({ model: name ?? '' })
	);
	const xrayOnThis = $derived($stackOpen && $xrayMessageId === messageId);
	function toggleXray() {
		if (xrayOnThis) {
			stackOpen.set(false);
			return;
		}
		xrayMessageId.set(messageId);
		stackOpen.set(true);
	}
	// Second opinion lives in Step by step, so this action opens XRAY there on this answer (CUR-4187).
	function openSecondOpinion() {
		xrayMessageId.set(messageId);
		xraySecondOpinion.set(true);
		stackOpen.set(true);
	}
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1" data-answer-footer>
	{#if provenance === 'fixed'}
		<p class="type-caption text-fg-3" data-provenance="fixed">{chromeCopy(lang).fixedNotice}</p>
	{:else if provenance === 'unavailable'}
		<!-- Stated rather than implied, and deliberately not styled as a warning: an unverifiable
		     answer is a normal event on a lane that reports no provenance. -->
		<p class="type-caption text-fg-3" data-provenance="unavailable">{chromeCopy(lang).noProvenance}</p>
	{:else if name}
		<button
			type="button"
			onclick={toggleXray}
			aria-expanded={xrayOnThis}
			class="inline-flex min-w-0 items-center gap-1.5 type-caption text-fg-3 transition-control hover:text-fg-1"
			aria-label={howMadeLabel}
			data-how-made
			data-serving={serving.current ? undefined : 'hidden'}
		>
			{#if serving.current}
				{#if maker}<OrgLogo org={maker} size="xs" />{/if}
				<!-- A failover answer says so, with the same explanation ProvenanceBadge gives (CUR-1933). -->
				<span
					class="truncate"
					title={modelId ? provenanceLine({ modelId, backup, provider, backend, verifyMethod }) : undefined}
					data-provenance={modelId ? 'line' : undefined}
				>
					{makerName ? `${makerName} · ${name}` : name}{backup ? ` ${m.message_backupSuffix()}` : ''}
				</span>
				<span aria-hidden="true" class="text-fg-3">·</span>
			{/if}
			<span class="inline-flex items-center gap-1 underline decoration-line-3 underline-offset-2">
				<RiScan2Line aria-hidden="true" class="size-3.5" /> {chromeCopy(lang).howMade}
			</span>
		</button>
	{/if}

	{#if showActions}
		<div class="ml-auto flex items-center gap-0.5 text-fg-3">
			<Tooltip.Root>
				<Tooltip.Trigger variant="ghost" size="icon-xs" aria-label={copyLabel} onclick={copy}>
					{#if copyState === 'copied'}<RiCheckLine aria-hidden="true" />{:else if copyState === 'failed'}<RiErrorWarningLine aria-hidden="true" />{:else}<RiFileCopyLine aria-hidden="true" />{/if}
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Positioner side="top"><Tooltip.Popup>{copyState === 'idle' ? m.message_copy() : copyLabel}</Tooltip.Popup></Tooltip.Positioner>
				</Tooltip.Portal>
			</Tooltip.Root>
			{#if onretry}
				<Tooltip.Root>
					<Tooltip.Trigger variant="ghost" size="icon-xs" aria-label={m.message_retry()} onclick={onretry}>
						<RiRefreshLine aria-hidden="true" />
					</Tooltip.Trigger>
					<Tooltip.Portal>
						<Tooltip.Positioner side="top"><Tooltip.Popup>{m.message_retry()}</Tooltip.Popup></Tooltip.Positioner>
					</Tooltip.Portal>
				</Tooltip.Root>
			{/if}
			<!-- The honest "where this system is weak" note (WeakSpotsModal). It used to hang off the inline
			     provenance trace, which moved into XRAY; this keeps it one tap from every answer. -->
			<Tooltip.Root>
				<Tooltip.Trigger variant="ghost" size="icon-xs" aria-label={m.message_whereWeak()} onclick={() => weakSpotsOpen.set(true)}>
					<RiQuestionLine aria-hidden="true" />
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Positioner side="top"><Tooltip.Popup>{m.message_whereWeak()}</Tooltip.Popup></Tooltip.Positioner>
				</Tooltip.Portal>
			</Tooltip.Root>
			{#if secondOpinion}
				<Tooltip.Root>
					<Tooltip.Trigger variant="ghost" size="icon-xs" aria-label={m.message_secondOpinion()} onclick={openSecondOpinion} data-second-opinion-action>
						<RiTeamLine aria-hidden="true" />
					</Tooltip.Trigger>
					<Tooltip.Portal>
						<Tooltip.Positioner side="top"><Tooltip.Popup>{m.message_secondOpinion()}</Tooltip.Popup></Tooltip.Positioner>
					</Tooltip.Portal>
				</Tooltip.Root>
			{/if}
			{@render report?.()}
			{@render alternatives?.()}
		</div>
	{/if}
</div>
