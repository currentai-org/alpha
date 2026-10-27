<script lang="ts">
	// Agent confirmation gate (CUR-218): agent-service paused a tool call under
	// ACP_PERMISSION_POLICY=confirm and is waiting on a real answer — "the confirmation IS the security
	// boundary, so it must be legible" (CUR-54 constraint 4). Renders WHILE the turn is still loading
	// (ChatMessage does not gate this on `!loading` the way every other notice is) — the whole point is
	// acting on it inside agent-service's own timeout window, not after the turn already finished.
	//
	// Deliberately NEITHER button carries an accent color. design-system.md's rule picks Accent 1 for
	// "the one thing this screen most wants the user to do" — but a security decision that visually
	// nudges toward one answer is the opposite of legible, so both Allow and Deny stay identically
	// neutral (Border 2 pill, white icon) and are told apart by label and icon only.
	//
	// A click does NOT set `decision` locally — the authoritative resolution is the `confirm_result` SSE
	// frame the already-open event stream delivers (see messageProvenance.agentConfirmResolved). This
	// component only tracks its OWN transient "a request is in flight" state, separate from that.
	import { base } from '$lib/chat/paths';
	import RiCheckLine from '~icons/ri/check-line';
	import RiCloseLine from '~icons/ri/close-line';
	import { pendingConfirm } from '$lib/chat/stores/pendingConfirm.svelte';

	interface Props {
		conversationId: string;
		taskId: string;
		confirmId: string;
		kind: string;
		title: string;
		summary: string;
		/** Auto mode's plain sentence; the card leads with it and tucks the raw call away. (CUR-3142) */
		plain?: string;
		decision?: 'allow' | 'deny' | 'canceled';
		reason?: string;
		/** Epoch ms this confirmation auto-denies at. Absent on an older/coarse frame that (CUR-1094)
		 *  predates agent-service reporting its own timeout — the static fallback copy covers that case. */
		deadlineAt?: number;
		/** "mcp" when this asks before an MCP tool runs. Its answer goes to the elicitation (CUR-3026)
		 *  route, which the confirming turn polls, instead of agent-service's agent-confirm. */
		channel?: 'agent' | 'mcp';
	}
	let {
		conversationId,
		taskId,
		confirmId,
		kind,
		title,
		summary,
		plain,
		decision,
		reason,
		deadlineAt,
		channel,
	}: Props = $props();

	let sending: 'allow' | 'deny' | null = $state(null);
	let sendError: string | null = $state(null);

	// Ticks once a second only while there's a real deadline to count down and nobody has answered yet —
	// $effect re-runs (and cleans up its own previous interval) whenever `deadlineAt`/`decision` change,
	// so this stops ticking the instant a confirm_result frame resolves the card.
	let now = $state(Date.now());
	$effect(() => {
		if (deadlineAt === undefined || decision) return;
		const id = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(id);
	});
	const secondsLeft = $derived(
		deadlineAt !== undefined ? Math.max(0, Math.ceil((deadlineAt - now) / 1000)) : undefined
	);

	// Put this card's unanswered state somewhere the tab title can see it — the card itself
	// is inside the message body, so someone in another window gets no signal that anything is waiting.
	// Keyed on `decision` rather than on mount: this component is NOT replaced when its confirmation
	// resolves (ChatMessage keys the #each on confirmId and the `decision` prop changes underneath),
	// so mount/unmount alone would leave a resolved card counted until the whole message unmounted.
	// The cleanup covers navigation away with one still open. (CUR-1405)
	$effect(() => {
		if (decision) {
			pendingConfirm.resolve(confirmId);
			return;
		}
		pendingConfirm.open(confirmId);
		return () => pendingConfirm.resolve(confirmId);
	});

	// The route (agent-confirm/+server.ts) tags every thrown error with a stable `reason` alongside
	// its message (CUR-779) specifically so this doesn't collapse four different causes into one
	// generic string — a disabled flag, an ownership mismatch, and a dead task all need someone to do
	// something different about them, and only one of those someones is "click retry."
	const SEND_ERROR_COPY: Record<string, string> = {
		flag_disabled: 'Agent confirmations are turned off in this environment right now.',
		not_yours: "This confirmation isn't yours to answer.",
		not_found: 'This request is no longer available.',
		service_unreachable: 'The agent service is unreachable right now.',
	};

	async function answer(choice: 'allow' | 'deny') {
		if (sending || decision) return;
		sending = choice;
		sendError = null;
		try {
			const res =
				channel === 'mcp'
					? await fetch(`${base}/conversation/${conversationId}/elicitation`, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								elicitationId: confirmId,
								action: choice === 'allow' ? 'accept' : 'decline',
							}),
						})
					: await fetch(`${base}/conversation/${conversationId}/agent-confirm`, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ taskId, confirmId, decision: choice }),
						});
			if (res.ok) return;
			// 409 (already resolved) is not a failure to report — the confirm_result frame already
			// carries, or is about to carry, the real outcome. Leave the buttons disabled; the SSE
			// frame replaces this whole branch with the resolved view shortly.
			if (res.status === 409) return;
			const body: { reason?: string } = await res.json().catch(() => ({}));
			sendError = (body.reason && SEND_ERROR_COPY[body.reason]) || "Couldn't send that — try again.";
			sending = null;
		} catch {
			sendError = "Couldn't reach the server — try again.";
			sending = null;
		}
	}

	const resolvedCopy = $derived(
		decision === 'allow'
			? 'Allowed.'
			: decision === 'canceled'
				? 'Canceled.'
				: reason === 'timeout'
					? 'No answer arrived in time — denied.'
					: 'Denied.'
	);
</script>

<div
	class="mt-1.5 flex flex-col gap-1.5 border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-2 text-[color:var(--ap-ink)] rounded-card"
>
	{#if decision}
		<div class="flex items-center gap-2 text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-3)]">
			<span
				class="inline-block size-[6px] shrink-0 rounded-full"
				style="background: var(--ap-ink-3)"
			></span>
			<span>{title || kind} — {resolvedCopy}</span>
		</div>
	{:else}
		<div class="flex items-start gap-2">
			<span
				class="relative top-1 inline-block size-[6px] shrink-0 rounded-full"
				style="background: var(--ap-building)"
			></span>
			<div class="flex flex-col gap-0.5">
				<span class="text-[length:var(--ap-text-2)] font-medium">
					This turn wants to: {plain || title || kind}
				</span>
				{#if plain}
					<details class="text-small text-fg-3">
						<summary class="cursor-pointer">Details</summary>
						<span class="block">{title || kind}</span>
						{#if summary}<span class="block break-all">{summary}</span>{/if}
					</details>
				{:else if summary}
					<span class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-3)]">{summary}</span>
				{/if}
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-1.5">
			<button
				type="button"
				disabled={sending !== null}
				onclick={() => answer('allow')}
				class="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-2.5 text-[length:var(--ap-text-2)] text-[color:var(--ap-ink)] transition-colors hover:bg-white/15 disabled:opacity-50"
			>
				<RiCheckLine class="size-3.5" />
				{sending === 'allow' ? 'Allowing…' : 'Allow'}
			</button>
			<button
				type="button"
				disabled={sending !== null}
				onclick={() => answer('deny')}
				class="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-2.5 text-[length:var(--ap-text-2)] text-[color:var(--ap-ink)] transition-colors hover:bg-white/15 disabled:opacity-50"
			>
				<RiCloseLine class="size-3.5" />
				{sending === 'deny' ? 'Denying…' : 'Deny'}
			</button>
			<span class="text-[length:var(--ap-text-1)] text-[color:var(--ap-ink-3)]">
				{secondsLeft !== undefined
					? `Times out to Deny in ${secondsLeft}s`
					: 'Times out to Deny if nobody answers.'}
			</span>
		</div>
		{#if sendError}
			<span class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-3)]">{sendError}</span>
		{/if}
	{/if}
</div>
