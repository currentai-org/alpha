<script lang="ts">
	// getInvitation requires the caller's own session email to match the invite. CUR-2835: a
	// dead link and the wrong account each get their own line and a way on, in place of Better Auth's
	// "Invitation not found!" and "You are not the recipient of the invitation". The wrong account is
	// never told whose invitation it is. (CUR-550)
	import { onMount } from "svelte";
	import { goto, invalidateAll } from "$app/navigation";
	import { authClient } from "$lib/chat/authClient";
	import { ORGANIZATION_ERROR_CODES } from "better-auth/client/plugins";
	import { base } from "$lib/chat/paths";

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
			loadError =
				"This invitation was sent to a different email address. Sign out, then open the link again and sign in with the address it was sent to.";
		} else if (error?.status === 400) {
			// Every 400 from get-invitation means the link is dead: cancelled, used or expired (sent with no
			// code at all), its workspace deleted, or its inviter gone (CUR-2835).
			loadError =
				"This invitation was cancelled or has expired. Ask the person who invited you for a new one.";
		} else if (error) {
			loadError = error.message ?? "Couldn't load that invitation.";
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
			actionError = error.message ?? "Couldn't accept that invitation.";
			return;
		}
		// busy stays "accept" through the navigation, so the button keeps saying Joining… (CUR-3281).
		outcome = "accepted";
		// The pending-invite list and workspace scope come from the chat layout's load, which a plain
		// goto keeps; without the reload Settings could list the accepted invite as pending (CUR-4167).
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
			actionError = error.message ?? "Couldn't decline that invitation.";
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
	<title>Workspace invitation — Alpha</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-md flex-col gap-4 p-6 text-[length:var(--ap-text-3)] text-[color:var(--ap-ink)]">
	{#if !ready}
		<p class="text-[color:var(--ap-ink-3)]">Loading invitation…</p>
	{:else if loadError}
		<p class="border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-2 rounded-card">{loadError}</p>
		<div class="flex gap-2">
			{#if wrongAccount}
				<button type="button" class={buttonClass} onclick={signOut}>Sign out</button>
			{/if}
			<a class={buttonClass} href={`${base}/`}>Back to chat</a>
		</div>
	{:else if outcome === "declined"}
		<p class="border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-2 rounded-card">
			You've declined this invitation.
		</p>
	{:else if invitation}
		<h2 class="text-[length:var(--ap-text-5)] font-semibold">
			Join {invitation.organizationName}
		</h2>
		<p class="text-[color:var(--ap-ink-2)]">
			{invitation.inviterEmail} invited you to join <strong>{invitation.organizationName}</strong> as
			a member.
		</p>
		{#if actionError}
			<p class="border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-2 rounded-card">{actionError}</p>
		{/if}
		<div class="flex gap-2">
			<button type="button" class={buttonClass} disabled={!!busy} onclick={accept}>
				{busy === "accept" ? "Joining…" : "Accept"}
			</button>
			<button type="button" class={buttonClass} disabled={!!busy} onclick={decline}>
				{busy === "reject" ? "Declining…" : "Decline"}
			</button>
		</div>
	{/if}
</div>
