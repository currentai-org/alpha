<script lang="ts">
	import { page } from "$app/state";
	import { base } from "$lib/chat/paths";
	import { Button, Textarea } from "@aipotluck/alpha-ds";
	import { trackEvent } from "$lib/analytics";
	import { reportActionHoldCount } from "$lib/chat/stores/reportHold";
	import { m } from "$lib/paraglide/messages.js";

	// The way to challenge a policy decline that /about promises. The decline text itself stays
	// "Current AI set this limit (rule: X)." with nothing added (CUR-3205); this is interface around it.
	// A challenge is an answer report with reason `refused`, so staff review it on /chat/admin/reports and
	// the person sees the outcome under Your reports (CUR-3903). It never goes back to the model: a model
	// gives way to a pushed-back user, so an in-chat "are you sure?" would be a way round the screen. (CUR-3902)
	interface Props {
		messageId: string;
	}
	let { messageId }: Props = $props();

	let open = $state(false);
	let note = $state("");
	let busy = $state(false);
	let sent = $state(false);
	let failed = $state(false);

	async function send() {
		if (busy) return;
		busy = true;
		failed = false;
		// Same hold as ReportButton: a post-turn resync mid-send would remount this and lose the note.
		reportActionHoldCount.update((n) => n + 1);
		try {
			const res = await fetch(`${base}/conversation/${page.params.id}/report`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messageId, reason: "refused", detail: note.trim() || undefined }),
			});
			if (!res.ok) throw new Error(`challenge failed: ${res.status}`);
			sent = true;
			trackEvent("decline_challenge_sent", { with_note: note.trim().length > 0 });
		} catch (err) {
			console.error(err);
			failed = true;
		} finally {
			busy = false;
			reportActionHoldCount.update((n) => n - 1);
		}
	}
</script>

<div class="mt-1 type-caption text-fg-2" data-decline-challenge>
	{#if sent}
		<p role="status">
			{m.decline_challengeSent()}
			{m.report_sentHelpReports()}
			<a href={`${base}/settings/reports`} class="underline underline-offset-2" data-own-reports-link
				>{m.product_yourReports()}</a
			>.
		</p>
	{:else if !open}
		<p>
			{m.decline_challengePrompt()}
			<Button variant="link" casing="sentence" onclick={() => (open = true)}>{m.decline_challengeAction()}</Button>
		</p>
	{:else}
		<form
			class="flex max-w-prose flex-col gap-2 pt-1"
			onsubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			<label class="flex flex-col gap-1">
				<span>{m.decline_challengeNoteLabel()}</span>
				<Textarea bind:value={note} maxlength={2000} minRows={2} disabled={busy} />
			</label>
			<div class="flex items-center gap-2">
				<Button type="submit" variant="secondary" size="sm" casing="sentence" disabled={busy}
					>{m.decline_challengeSend()}</Button
				>
				<div role="status" aria-live="polite">
					{#if busy}
						{m.message_reportSending()}
					{:else if failed}
						<span class="text-caution-text">{m.message_reportFailed()}</span>
					{/if}
				</div>
			</div>
		</form>
	{/if}
</div>
