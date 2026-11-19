<script lang="ts">
	import AnchoredModal from "$lib/chat/components/AnchoredModal.svelte";
	import { Button, Input } from "@aipotluck/alpha-ds";
	import RiDeleteBinFill from "~icons/ri/delete-bin-fill";
	import { deleteAllAnchor } from "$lib/chat/stores/deleteAll";
	import { onMount } from "svelte";
	import type { WipeSummary, WipePreview } from "$lib/chat/types/WipeSummary";
	import { page } from "$app/state";
	import { trackEvent } from "$lib/analytics";
	import { apiErrorMessage } from "$lib/chat/APIClient";
	import { base } from "$lib/chat/paths";
	import HfAccessNote from "$lib/chat/components/storage/HfAccessNote.svelte";
	import type { LocationSummary } from "$lib/chat/components/storage/locationTypes";

	interface Props {
		open?: boolean;
		onclose?: () => void;
		/** Performs the wipe; resolves with what was cleared (for the reassurance panel). */
		ondelete?: () => Promise<WipeSummary | void> | void;
		/** Fired when the user dismisses the post-wipe panel (do the store reset + navigation here). */
		onfinish?: () => void;
		/** "data" is Forget everything: the account stays. "account" is Delete account, which also removes the
		 *  account and its sign-in methods and asks for a typed confirmation first. */
		mode?: "data" | "account";
	}

	let { open = false, onclose, ondelete, onfinish, mode = "data" }: Props = $props();

	type Phase = "confirm" | "working" | "done" | "error";
	let phase = $state<Phase>("confirm");
	let summary = $state<WipeSummary | null>(null);
	let errorMsg = $state("");

	// Initial focus goes to Cancel, the safe choice: an Enter or Space pressed on arrival must not run
	// an irreversible wipe.
	let cancelButtonEl: HTMLButtonElement | undefined = $state();

	// Whether this wipe will also delete the account: only the account page's "Delete account" asks for
	// that, and only a signed-in person has one. Known before the wipe runs, so the confirm
	// names it up front instead of only disclosing it on the done panel.
	let signedIn = $derived(!!page.data.user);
	let willDeleteAccount = $derived(mode === "account" && signedIn);
	// Carries its own leading space: whitespace before an `{#if}` in markup is trimmed, which ran
	// the two sentences together as "servers.It".
	let accountSentence = $derived(
		willDeleteAccount
			? " It also deletes your account and sign-in methods, and any files you uploaded."
			: signedIn
				? " It also deletes any files you uploaded. You stay signed in, and your account stays."
				: ""
	);

	// The wipe forgets linked buckets but never touches them; they're the person's own. Read
	// them when the modal opens so the confirm can name what stays, and so the done panel still knows
	// after the rows are gone. Not available (flag off, signed out) reads as none.
	let linkedStorage = $state<LocationSummary[]>([]);
	$effect(() => {
		if (!open || !signedIn) return;
		fetch(`${base}/api/storage/locations`)
			.then((r) => (r.ok ? r.json() : null))
			.then((s: { locations?: LocationSummary[] } | null) => {
				linkedStorage = (s?.locations ?? []).filter((l) => l.kind !== "alpha");
			})
			.catch(() => {});
	});

	// Deleting an account takes a typed word, the friction the content team asked for: one stray click
	// on a button that reads like the one before it must not remove someone's sign-in methods.
	const CONFIRM_WORD = "DELETE";
	let typed = $state("");
	let typedOk = $derived(typed.trim().toUpperCase() === CONFIRM_WORD);
	let canConfirm = $derived(!willDeleteAccount || typedOk);

	function close() {
		// If the wipe already ran (phase "done"), ANY dismissal — the X, Esc, or a backdrop click, not
		// just the Done button — must still run the post-wipe cleanup (store reset + nav). Otherwise the
		// deleted conversations linger client-side until a reload, and clicking one 404s. Guard against a
		// double-fire from finish() with a flag.
		if (phase === "done" && !finished) {
			finished = true;
			onfinish?.();
		}
		open = false;
		onclose?.();
	}

	let finished = $state(false);

	async function confirmDelete() {
		if (!canConfirm) return;
		phase = "working";
		try {
			const res = await ondelete?.();
			summary = res ?? null;
			phase = "done";
			trackEvent("data_erased", { logged_in: !!page.data.user });
		} catch (e) {
			// The server's own sentence ("nothing was cleared") when it sent one, otherwise a generic line.
			errorMsg = apiErrorMessage(
				e,
				"Something went wrong and your data may not be fully cleared. Please try again."
			);
			phase = "error";
		}
	}

	function finish() {
		close();
	}

	// What the wipe will remove, counted before anything is deleted, so the confirm lists the same buckets
	// and counts the receipt will. null while loading or when the count failed, in which case
	// the confirm keeps its generic sentence.
	let preview = $state<WipePreview | null>(null);
	let previewState = $state<"idle" | "loading" | "ready" | "failed">("idle");
	$effect(() => {
		if (!open || phase !== "confirm") return;
		const account = willDeleteAccount ? "?account=delete" : "";
		let stale = false;
		previewState = "loading";
		fetch(`${base}/api/v2/conversations/wipe-preview${account}`)
			.then((r) => (r.ok ? (r.json() as Promise<WipePreview>) : Promise.reject(new Error(String(r.status)))))
			.then((p) => {
				if (stale) return;
				preview = p;
				previewState = "ready";
			})
			.catch(() => {
				if (stale) return;
				preview = null;
				previewState = "failed";
			});
		return () => {
			stale = true;
		};
	});

	// Honest, plain-language list of what is cleared. One function for the confirm and the receipt, so
	// the two panels cannot word the same bucket differently. Only nonzero buckets are shown so the panel doesn't list "0 contributions".
	function linesFor(s: WipePreview | WipeSummary | null): string[] {
		if (!s) return [];
		const full = s as Partial<WipeSummary> & { agentHistoryPossible?: boolean };
		const n = (v: number | undefined) => v ?? 0;
		return [
			s.conversations > 0 ? `${s.conversations} conversation${s.conversations === 1 ? "" : "s"}` : null,
			s.settings > 0 ? "your saved settings" : null,
			s.messageEvents > 0 ? `${s.messageEvents} usage record${s.messageEvents === 1 ? "" : "s"}` : null,
			s.contributions > 0 ? `${s.contributions} form submission${s.contributions === 1 ? "" : "s"}` : null,
			s.localInferenceEndpoints > 0 ? "your local inference server settings" : null,
			s.storageLocations > 0
				? "the links to your own storage buckets (the files in them stay in your account)"
				: null,
			n(full.custodialFiles) > 0
				? `${full.custodialFiles} uploaded file${full.custodialFiles === 1 ? "" : "s"}`
				: null,
			s.safetyEvents > 0
				? `${s.safetyEvents} record${s.safetyEvents === 1 ? "" : "s"} of messages we declined to answer`
				: null,
			n(full.agentServiceTasksDeleted) > 0
				? `${full.agentServiceTasksDeleted} agent task${full.agentServiceTasksDeleted === 1 ? "" : "s"}`
				: "agentHistoryPossible" in s && s.agentHistoryPossible
					? "any agent task history"
					: null,
			s.accountDeleted ? "your account and sign-in methods" : null,
		].filter((x): x is string => x !== null);
	}
	let clearedLines = $derived(linesFor(summary));
	let previewLines = $derived(linesFor(preview));

	onMount(() => {
		setTimeout(() => {
			cancelButtonEl?.focus();
		}, 100);
	});
</script>

{#if open}
	<!-- "Forget everything" wipe confirmation, redesigned to the Alpha mockup (Figma 468:32074): a
	     white card dropping down attached beneath the "forget everything" button (which inverts to ink
	     while open). Title in DM Mono, body in Plus Jakarta, black/grey action buttons. The confirm →
	     working → done → error phase machine is preserved; only the chrome changed. -->
	<AnchoredModal anchor={$deleteAllAnchor} widthPx={340} align="right" closeOnBackdrop={phase !== "working"} onclose={close}>
		<div class="flex w-full flex-col gap-4 p-5">
			<h2 class="type-heading text-fg-1">
				{#if phase === "done"}
					Your data has been cleared
				{:else if phase === "error"}
					Couldn't clear your data
				{:else if willDeleteAccount}
					Delete your account?
				{:else}
					Forget everything?
				{/if}
			</h2>

			{#if phase === "confirm" || phase === "working"}
				<div class="flex flex-col gap-2 type-body text-fg-2">
					<p>We do not want to keep your data.</p>
					<!-- A signed-in person's records are tied to their account, not anonymous, and the wipe
					     reaches past this device. -->
					<p>
						{#if signedIn}
							This clears your chats, settings and usage records from this device and from our
							servers.{accountSentence}
						{:else}
							This clears everything we hold about you on this device: your chats, settings, and the
							anonymous usage records tied to you, and removes it from our servers.{accountSentence}
						{/if}
					</p>
					{#if linkedStorage.length}
						<p data-testid="wipe-linked-storage">
							Your Hugging Face storage ({linkedStorage.map((l) => l.detail || l.label).join(", ")}) stays in
							your Hugging Face account with its files. Alpha only loses access to it.
						</p>
					{/if}
					{#if previewState === "loading"}
						<p class="type-caption text-fg-3" data-testid="wipe-preview-loading">Counting what we hold…</p>
					{:else if previewState === "ready"}
						<div data-testid="wipe-preview">
							{#if previewLines.length}
								<p>We will delete and remove from our servers:</p>
								<ul class="list-disc space-y-1 pl-5">
									{#each previewLines as line (line)}
										<li>{line}</li>
									{/each}
								</ul>
							{:else}
								<p>There is nothing tied to you to clear right now.</p>
							{/if}
						</div>
					{/if}
					<p class="font-medium text-fg-1">This action cannot be undone.</p>
				</div>

				{#if willDeleteAccount}
					<label class="flex flex-col gap-1.5 type-body text-fg-2">
						<span>Type <span class="type-code text-fg-1">{CONFIRM_WORD}</span> to confirm</span>
						<Input bind:value={typed} autocomplete="off" spellcheck={false} disabled={phase === "working"} />
					</label>
				{/if}

				<!-- Destructive per spec: a normal bordered button, Text 1 label, only the fill icon in Accent 2.
				     the confirm repeats the verb of the control that opened it ("Forget everything"),
				     so a permanent action reads as the one the person asked for. -->
				<div class="flex gap-2">
					<Button variant="destructive" block class="flex-1" onclick={confirmDelete} disabled={phase === "working" || !canConfirm}>
						<RiDeleteBinFill aria-hidden="true" />
						{phase === "working" ? "Clearing…" : willDeleteAccount ? "Delete account" : "Forget everything"}
					</Button>
					<Button bind:ref={cancelButtonEl} block class="flex-1" onclick={close} disabled={phase === "working"}>
						Cancel
					</Button>
				</div>
			{:else if phase === "done"}
				<div class="flex flex-col gap-2.5 type-body text-fg-2">
					{#if clearedLines.length}
						<p>We deleted and removed from our servers:</p>
						<ul data-testid="wipe-receipt" class="list-disc space-y-1 pl-5">
							{#each clearedLines as line (line)}
								<li>{line}</li>
							{/each}
						</ul>
					{:else}
						<p>There was nothing tied to you left to clear — you're starting fresh.</p>
					{/if}

					{#if linkedStorage.length}
						<p class="type-caption" data-testid="wipe-linked-storage-done">
							<HfAccessNote grants={linkedStorage.map((l) => l.grant)} />
						</p>
					{/if}

					{#if summary && summary.reportsRetained > 0}
						<p class="border border-line-surface bg-surface-raised p-2.5 type-caption">
							One exception: {summary.reportsRetained} safety report{summary.reportsRetained === 1
								? ""
								: "s"} you or our automated checks filed {summary.reportsRetained === 1
								? "is"
								: "are"} kept for legal compliance. We removed the link back to your conversation, so
							{summary.reportsRetained === 1 ? "it no longer points" : "they no longer point"} to you.
						</p>
					{/if}

					<p class="type-caption text-fg-3">
						This covers what we hold directly. Messages you sent also passed through the model
						provider and our safety and analytics tooling, each under its own retention — those
						aren't affected by this action.
					</p>
				</div>

				<Button variant="primary" block onclick={finish}>Done</Button>
			{:else}
				<p class="type-body text-fg-2">{errorMsg}</p>

				<div class="flex gap-2">
					<Button variant="primary" block class="flex-1" onclick={confirmDelete}>Try again</Button>
					<Button block class="flex-1" onclick={close}>Close</Button>
				</div>
			{/if}
		</div>
	</AnchoredModal>
{/if}
