<script lang="ts">
	import { brandOf } from '$lib/chat/brand';
	import { fileStoreOf, filesHomeCopy } from '$lib/chat/fileStoreCopy';
	import RiHardDrive2Line from '~icons/ri/hard-drive-2-line';
	import { m } from '$lib/paraglide/messages.js';
	import { page } from "$app/state";
	import { base } from "$lib/chat/paths";
	import { DangerRow, Surface } from "@aipotluck/alpha-ds";
	import { deleteAllAnchor, deleteAllMode, deleteAllOpen } from "$lib/chat/stores/deleteAll";
	import { RETENTION_DAYS } from "$lib/chat/constants/retention";
	import { DATA_HOME, orgs } from "$lib/chat/routing/catalog";
	import OrgLogo from "$lib/chat/components/provenance/OrgLogo.svelte";
	import PotluckMark from "$lib/chat/components/PotluckMark.svelte";
	import RiDeleteBinFill from "~icons/ri/delete-bin-fill";
	import RiArrowRightUpLine from "~icons/ri/arrow-right-up-line";
	import AccountUsage from "$lib/chat/components/settings/AccountUsage.svelte";
	import SharedLinks from "$lib/chat/components/settings/SharedLinks.svelte";

	// Settings → Data & privacy: where your data lives (the words come from DATA_HOME), how long it is
	// kept, and the "Forget everything" wipe. The wipe is a page, not an account-menu row: a destructive, account-wide
	// action reads better as a page you arrive at deliberately than as a menu row one slip away from
	// "Log out". It opens DeleteAllConversationsModal (mounted once in ChatShell) in "data" mode: a
	// signed-in person's data goes and their account stays. Deleting the account is its own
	// action, on the Account page.
	const filesHost = orgs[DATA_HOME.filesHost];
	const signedIn = $derived(Boolean(page.data.user));
	// Layout data's `shareLinksEnabled`: signed in, share-links flag on.
	const shareLinksOffered = $derived(page.data.shareLinksEnabled === true);

	// With a bucket of their own linked, "held by Current AI" is false for that bucket's files.
	// Read the same way the Forget everything confirm does; unavailable (flag off) reads as none.
	let hasLinkedBucket = $state(false);
	$effect(() => {
		if (!signedIn) return;
		fetch(`${base}/api/storage/locations`)
			.then((r) => (r.ok ? r.json() : null))
			.then((s: { locations?: { kind: string }[] } | null) => {
				hasLinkedBucket = (s?.locations ?? []).some((l) => l.kind !== "alpha");
			})
			.catch(() => {});
	});

	let forgetButton: HTMLElement | null = $state(null);
	function forgetEverything() {
		deleteAllAnchor.set(forgetButton ?? undefined);
		deleteAllMode.set("data");
		deleteAllOpen.set(true);
	}
</script>

<div class="flex flex-col gap-8">
	<section class="flex flex-col gap-4" aria-labelledby="storage-heading">
		<h2 id="storage-heading" class="type-label text-fg-1">{m.data_whereTitle()}</h2>
		<div class="flex gap-3">
			<span class="grid size-8 shrink-0 place-items-center rounded-sharp border border-line-2 bg-surface-1">
				<PotluckMark class="size-4" />
			</span>
			<div class="flex flex-col gap-1">
				<p class="type-body text-fg-2">{m.data_chatsHome({ organisation: brandOf(page.data).organisation })}</p>
				<p class="type-caption text-fg-3">
					{#if signedIn}
						{m.data_keptSignedIn()}
					{:else}
						{m.data_keptGuest({ days: RETENTION_DAYS })}
					{/if}
					{m.data_seeWhoMade()}
				</p>
			</div>
		</div>
		<!-- a guest has no way to upload (no attach button, and My files needs an account), so
		the line about where uploads are stored is only true once signed in. -->
		{#if signedIn}
			<div class="flex gap-3">
				<!-- The Hugging Face logo only where Hugging Face holds the files; another store gets a plain mark. -->
				{#if fileStoreOf(page.data) === "hf-bucket"}
					<OrgLogo org={filesHost} size="md" />
				{:else}
					<span class="grid size-8 shrink-0 place-items-center rounded-sharp border border-line-2 bg-surface-1">
						<RiHardDrive2Line class="size-4" aria-hidden="true" />
					</span>
				{/if}
				<p class="type-body text-fg-2" data-testid="data-home-files">
					{filesHomeCopy(fileStoreOf(page.data), hasLinkedBucket, brandOf(page.data).organisation)}
				</p>
			</div>
		{/if}
	</section>

	<AccountUsage />

	{#if shareLinksOffered}
		<SharedLinks />
	{/if}

	<!-- the same DangerRow in a Surface as Delete account on the Account page, so the two
	     danger zones match in frame and button size. -->
	<section class="flex flex-col gap-3" aria-labelledby="forget-heading">
		<h2 id="forget-heading" class="type-label text-fg-1">{m.chat_forgetEverything()}</h2>
		<Surface level="2" border="auto">
			<DangerRow bind:ref={forgetButton} onclick={forgetEverything} data-forget-everything>
				{#snippet description()}
					{m.data_forgetHelp()}
					{#if signedIn}{m.data_forgetKeepsAccount()}{/if}
					{m.data_cantUndo()}
				{/snippet}
				<RiDeleteBinFill aria-hidden="true" />
				<span>{m.data_forgetButton()}</span>
			</DangerRow>
		</Surface>
	</section>

	<a
		href="/privacy-notice"
		class="inline-flex items-center gap-1.5 self-start type-caption text-fg-2 underline decoration-line-3 underline-offset-2 hover:text-fg-1"
	>
		<RiArrowRightUpLine aria-hidden="true" class="size-3.5" /> {m.data_readPrivacyNotice()}
	</a>
</div>
