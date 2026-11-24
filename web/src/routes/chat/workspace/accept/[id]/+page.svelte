<script lang="ts">
	// getInvitation requires the caller's own session email to match the invite. a
	// dead link and the wrong account each get their own line and a way on, in place of Better Auth's
	// "Invitation not found!" and "You are not the recipient of the invitation". The wrong account is
	// never told whose invitation it is.
	import { onMount } from "svelte";
	import { goto, invalidateAll } from "$app/navigation";
	import { authClient } from "$lib/chat/authClient";
	import { ORGANIZATION_ERROR_CODES } from "better-auth/client/plugins";
	import { base } from "$lib/chat/paths";
	import { m } from "$lib/paraglide/messages.js";

	import type { PageData } from "./$types";
	let { data }: { data: PageData } = $props();

	type InvitationDetail = {
		id: string;
		email: string;
		role: string;
		organizationName: string;
		inviterEmail: string;
	};

	let ready = $state(false);
	let invitation = $state<InvitationDetail | null>(null);
	let loadError = $state("");
	let wrongAccount = $state(false);
	let busy = $state<"accept" | "reject" | null>(null);
	let actionError = $state("");
	let outcome = $state<"accepted" | "declined" | null>(null);

	onMount(async () => {
		const { data: res, error } = await authClient.organization.getInvitation({
			query: { id: data.invitationId },
		});
		if (error?.code === ORGANIZATION_ERROR_CODES.YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION.code) {
			wrongAccount = true;
			loadError = m.workspace_acceptWrongAccount();
		} else if (error?.status === 400) {
			// Every 400 from get-invitation means the link is dead: cancelled, used or expired (sent with no
			// code at all), its workspace deleted, or its inviter gone.
			loadError = m.workspace_acceptExpired();
		} else if (error) {
			// The auth client's error text is English; show the visitor's own language instead.
			loadError = m.workspace_acceptLoadFailed();
		} else {
			invitation = res as InvitationDetail;
		}
		ready = true;
	});

	async function accept() {
		if (busy || !invitation) return;
		busy = "accept";
		actionError = "";
		const { error } = await authClient.organization.acceptInvitation({ invitationId: invitation.id });
		if (error) {
			busy = null;
			actionError = m.workspace_acceptFailed();
			return;
		}
		// busy stays "accept" through the navigation, so the button keeps saying Joining….
		outcome = "accepted";
		// The pending-invite list and workspace scope come from the chat layout's load, which a plain
		// goto keeps; without the reload Settings could list the accepted invite as pending.
		goto(`${base}/settings/workspace`, { invalidateAll: true });
	}

	async function signOut() {
		await authClient.signOut();
		// Signed out, this page's server load sends them to sign-in with `next` set back here.
		window.location.reload();
	}

	async function decline() {
		if (busy || !invitation) return;
		busy = "reject";
		actionError = "";
		const { error } = await authClient.organization.rejectInvitation({ invitationId: invitation.id });
		busy = null;
		if (error) {
			actionError = m.workspace_declineInviteFailed();
			return;
		}
		outcome = "declined";
		// So the account menu stops counting the declined invite.
		await invalidateAll();
	}

	const buttonClass =
		"flex h-9 flex-none items-center gap-1.5 border border-[var(--ap-border-2)] bg-[var(--ap-paper-3)] px-3.5 text-[length:var(--ap-text-3)] text-[color:var(--ap-ink)] transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40";
</script>

<svelte:head>
	<title>{m.workspace_acceptPageTitle()}</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-md flex-col gap-4 p-6 text-[length:var(--ap-text-3)] text-[color:var(--ap-ink)]">
	{#if !ready}
		<p class="text-[color:var(--ap-ink-3)]">{m.workspace_acceptLoading()}</p>
	{:else if loadError}
		<p class="border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-2 rounded-card">{loadError}</p>
		<div class="flex gap-2">
			{#if wrongAccount}
				<button type="button" class={buttonClass} onclick={signOut}>{m.workspace_acceptSignOut()}</button>
			{/if}
			<a class={buttonClass} href={`${base}/`}>{m.workspace_acceptBackToChat()}</a>
		</div>
	{:else if outcome === "declined"}
		<p class="border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-2 rounded-card">
			{m.workspace_acceptDeclined()}
		</p>
	{:else if invitation}
		<h2 class="text-[length:var(--ap-text-5)] font-semibold">
			{m.workspace_acceptHeading({ name: invitation.organizationName })}
		</h2>
		<p class="text-[color:var(--ap-ink-2)]">
			{m.workspace_acceptInvitedYou({ email: invitation.inviterEmail, name: invitation.organizationName })}
		</p>
		{#if actionError}
			<p class="border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-2 rounded-card">{actionError}</p>
		{/if}
		<div class="flex gap-2">
			<button type="button" class={buttonClass} disabled={!!busy} onclick={accept}>
				{busy === "accept" ? m.workspace_accepting() : m.workspace_accept()}
			</button>
			<button type="button" class={buttonClass} disabled={!!busy} onclick={decline}>
				{busy === "reject" ? m.workspace_declining() : m.workspace_declineInvite()}
			</button>
		</div>
	{/if}
</div>
