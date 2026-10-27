<script lang="ts">
	import { page } from "$app/state";
	import { base } from "$lib/chat/paths";
	import RiFlagLine from "~icons/ri/flag-line";
	import { Menu, Tooltip } from "@aipotluck/alpha-ds";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import { trackEvent } from "$lib/analytics";
	import { reportActionHoldCount } from "$lib/chat/stores/reportHold";
	import { ANSWER_REPORT_REASONS, type AnswerReportReason } from "$lib/chat/reportReasons";
	import { m } from "$lib/paraglide/messages.js";

	// "Report a problem" — the flag control every session carries and the Terms
	// page points users to. Opens a small reason menu and POSTs to the conversation's report
	// endpoint (→ saveReport → ROOST triage seam). The reasons come from reportReasons.ts.
	interface Props {
		messageId: string;
		// Analytics-only: 1-indexed turn position.
		turnNumber?: number;
		/** Called once a report is filed, with its reason. */
		onreported?: (reason: string) => void;
	}
	let { messageId, turnNumber, onreported }: Props = $props();

	const REASONS = ANSWER_REPORT_REASONS;
	// reportReasons.ts keeps the English labels for the server and the admin page; the menu shows
	// the visitor's language.
	const REASON_LABEL: Record<AnswerReportReason, () => string> = {
		harmful: () => m.message_reportHarmful(),
		inaccurate: () => m.message_reportInaccurate(),
		refused: () => m.message_reportRefused(),
		language: () => m.message_reportLanguage(),
		privacy: () => m.message_reportPrivacy(),
		other: () => m.message_reportOther(),
	};

	let open = $state(false);
	let busy = $state(false);
	let done = $state(false);
	let failed = $state(false);

	async function submit(reason: string) {
		if (busy) return;
		busy = true;
		failed = false;
		// Hold the page's post-turn resync for as long as this submission (and its
		// acknowledgement) is on screen — see reportHold.ts. Released exactly once per increment,
		// on every exit path, from a module-level store so it still fires correctly even if a
		// resync this same hold prevented would otherwise have destroyed this component first. (CUR-1583)
		reportActionHoldCount.update((n) => n + 1);
		try {
			const res = await fetch(`${base}/conversation/${page.params.id}/report`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messageId, reason }),
			});
			if (!res.ok) throw new Error(`report failed: ${res.status}`);
			done = true;
			onreported?.(reason);
			setTimeout(() => {
				open = false;
				done = false;
				reportActionHoldCount.update((n) => n - 1);
			}, 1800);
		} catch (err) {
			console.error(err);
			failed = true;
			reportActionHoldCount.update((n) => n - 1);
		} finally {
			busy = false;
		}
	}
</script>

<!-- The design system's Menu anchors the reasons below the flag and flips above it only when the
     viewport has no room there. Opening always upward would cover the answer it is
     reporting and its open-gap banner (CUR-2383). -->
<Menu.Root
	bind:open
	onOpenChange={(o) => {
		if (o) trackEvent("report_problem_clicked", { turn_number: turnNumber });
	}}
>
	<!-- Same ghost icon button + tooltip as Copy / Try again beside it, so it shares their hover. -->
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Menu.Trigger {...props} variant="ghost" size="icon-xs" aria-label={m.message_reportAnswer()}>
					<RiFlagLine aria-hidden="true" />
				</Menu.Trigger>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Portal>
			<Tooltip.Positioner side="top"><Tooltip.Popup>{m.message_reportAnswer()}</Tooltip.Popup></Tooltip.Positioner>
		</Tooltip.Portal>
	</Tooltip.Root>
	<Menu.Portal>
		<Menu.Positioner side="bottom" align="end" sideOffset={4}>
			<Menu.Popup class="w-60">
				{#if done}
					<div class="type-body flex items-center gap-2 px-2 py-2 text-fg-2">
						<CarbonCheckmark class="text-[var(--ap-live)]" />
						{m.message_reportThanks()}
					</div>
				{:else}
					<Menu.Group>
						<Menu.GroupLabel>{m.message_reportResponse()}</Menu.GroupLabel>
						{#each REASONS as r (r.key)}
							<!-- The menu stays open after a pick, so the acknowledgement lands where the person looked. -->
							<Menu.Item closeOnSelect={false} disabled={busy} onSelect={() => submit(r.key)}>
								{REASON_LABEL[r.key]()}
							</Menu.Item>
						{/each}
					</Menu.Group>
					<!-- The reasons are disabled while a report is in flight, so say why: without this line a
					     slow or failing request reads as a greyed-out menu (CUR-2637). -->
					<div role="status" aria-live="polite">
						{#if busy}
							<p class="type-body px-2 pt-1 text-fg-2">{m.message_reportSending()}</p>
						{:else if failed}
							<p class="type-body px-2 pt-1 text-[var(--ap-gap)]">{m.message_reportFailed()}</p>
						{/if}
					</div>
				{/if}
			</Menu.Popup>
		</Menu.Positioner>
	</Menu.Portal>
</Menu.Root>
