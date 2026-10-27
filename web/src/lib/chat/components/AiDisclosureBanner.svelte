<script lang="ts">
	// The EU AI Act's Article 50 requires telling a person AT FIRST INTERACTION that they're talking
	// to an AI (CUR-996). WelcomeModal covers that for the normal empty-composer path, but it's gated
	// on `!shared && messages.length === 0`, and a shared conversation almost always arrives WITH
	// messages, so that gate never fires for it ("Shared conversation views never show it," per
	// ChatWindow.svelte). Someone opening a shared link is having a genuine first interaction with
	// Alpha, so this banner is the disclosure on that path.
	//
	// Session-scoped, not persisted server-side like `welcomeModalSeen`: the requirement is once per
	// session, and most viewers of a shared link have no account to persist a setting against.
	// sessionStorage matches that literally and needs no new settings column. Same `ap:`-prefixed key
	// convention as ChatShell.svelte's SESSION_STARTED_KEY.
	//
	// Not yet localized into the person's language, like WelcomeModal; that remainder is tracked on
	// CUR-996.
	import { browser } from '$app/environment';
	import RiRobot from '~icons/ri/robot-line';
	import RiCloseLine from '~icons/ri/close-line';

	const STORAGE_KEY = 'ap:aiDisclosureSeen';

	function alreadySeen(): boolean {
		if (!browser) return false;
		try {
			return sessionStorage.getItem(STORAGE_KEY) === '1';
		} catch {
			// Private mode / storage disabled: fail toward SHOWING the disclosure, not hiding it —
			// the opposite failure direction from a UX convenience like the welcome modal's dismissal.
			return false;
		}
	}

	let dismissed = $state(alreadySeen());

	function dismiss() {
		dismissed = true;
		if (!browser) return;
		try {
			sessionStorage.setItem(STORAGE_KEY, '1');
		} catch {
			// Best-effort, same as sessionFootprint.svelte.ts — the banner still hid for this view.
		}
	}
</script>

{#if !dismissed}
	<div
		role="status"
		class="flex w-full items-center gap-2.5 border-b border-[var(--ap-rule)] bg-[var(--ap-ink)]/5 px-4 py-2 text-[length:var(--ap-text-2)] text-[var(--ap-ink)] md:px-5"
	>
		<RiRobot class="size-4 shrink-0" aria-hidden="true" />
		<div class="min-w-0 flex-1 leading-snug">
			You're talking to Alpha, an AI system — not a human.
		</div>
		<button
			type="button"
			aria-label="Dismiss"
			class="-mr-0.5 shrink-0 cursor-pointer rounded p-0.5 opacity-70 transition hover:opacity-100"
			onclick={dismiss}
		>
			<RiCloseLine class="size-4" aria-hidden="true" />
		</button>
	</div>
{/if}
