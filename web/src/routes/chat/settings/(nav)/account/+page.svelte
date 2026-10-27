<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime.js';
	// Account management over Better Auth's client (CUR-580): it ships listAccounts/linkSocial/
	// unlinkAccount/listSessions/revokeSession and the passkey plugin's
	// listUserPasskeys/deletePasskey/addPasskey, and this page calls them.
	// Every method below is the generic path-proxy (better-auth/dist/client/proxy.mjs) rather than a
	// hand-rolled fetch — `authClient.passkey.listUserPasskeys()` resolves to `/passkey/list-user-
	// passkeys`, `authClient.unlinkAccount(...)` to `/unlink-account`, checked against the installed
	// package's own route declarations, not assumed.
	//
	// Built on @aipotluck/alpha-ds (Surface cards, Button rows), matching login/+page.svelte.
	import { onMount } from "svelte";
	import { goto, invalidateAll } from "$app/navigation";
	import { Button, DangerRow, Input, Surface } from "@aipotluck/alpha-ds";
	import { page } from "$app/state";
	import { base } from "$lib/chat/paths";
	import { authClient } from "$lib/chat/authClient";
	import { deleteAllOpen, deleteAllAnchor, deleteAllMode } from "$lib/chat/stores/deleteAll";
	import { friendlyAuthErrorMessage } from "$lib/chat/authErrorMessages";
	import { describePlatform, suggestedPasskeyName } from "$lib/chat/utils/describePlatform";
	import { providerMeta, LINKABLE_PROVIDERS } from "$lib/chat/authProviderMeta";
	import RiLinkUnlink from "~icons/ri/link-unlink";
	import RiAddLine from "~icons/ri/add-line";
	import RiMailLine from "~icons/ri/mail-line";
	import RiFingerprintLine from "~icons/ri/fingerprint-line";
	import RiDeleteBinLine from "~icons/ri/delete-bin-line";
	import RiDeleteBinFill from "~icons/ri/delete-bin-fill";
	import RiComputerLine from "~icons/ri/computer-line";
	import RiDownload2Line from "~icons/ri/download-2-line";
	import RiLinksLine from "~icons/ri/links-line";
	import RiLogoutBoxLine from "~icons/ri/logout-box-line";

	import type { PageData } from "./$types";
	let { data }: { data: PageData } = $props();

	type LinkedAccount = {
		id: string;
		providerId: string;
		accountId: string;
		createdAt: string | Date;
		scopes: string[];
	};
	type PasskeyRow = {
		id: string;
		name?: string;
		deviceType: "singleDevice" | "multiDevice" | string;
		createdAt: string | Date;
	};
	type SessionRow = {
		id: string;
		token: string;
		createdAt: string | Date;
		updatedAt: string | Date;
		ipAddress?: string | null;
		userAgent?: string | null;
	};

	function fmtDate(d: string | Date) {
		return new Date(d).toLocaleDateString(getLocale(), {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	}

	function deviceTypeLabel(deviceType: string) {
		if (deviceType === "singleDevice") return m.account_thisDeviceOnly();
		if (deviceType === "multiDevice") return m.account_synced();
		return deviceType;
	}

	// Start from what +page.server.ts read, so the page arrives with its content. The
	// browser fetches only a section the server could not read. (CUR-2710)
	const initial = data.initial;
	type SessionResult = { session?: { token?: string } | null; user?: { email?: string | null; name?: string | null } | null } | null;
	const initialSession: SessionResult = initial.session.ok ? (initial.session.value as SessionResult) : null;
	const sessionsStartNotFresh = !initial.sessions.ok && initial.sessions.code === "SESSION_NOT_FRESH";

	let ready = $state(
		initial.accounts.ok &&
			initial.passkeys.ok &&
			(initial.sessions.ok || sessionsStartNotFresh) &&
			initial.session.ok
	);
	let accounts = $state<LinkedAccount[] | null>(
		initial.accounts.ok ? (initial.accounts.value as LinkedAccount[]) : null
	);
	let accountsError = $state("");
	let passkeys = $state<PasskeyRow[] | null>(
		initial.passkeys.ok ? (initial.passkeys.value as PasskeyRow[]) : null
	);
	let passkeysError = $state("");
	let sessions = $state<SessionRow[] | null>(
		initial.sessions.ok ? (initial.sessions.value as SessionRow[]) : null
	);
	let sessionsError = $state("");
	// Better Auth's own /list-sessions route gates on session freshness (default 24h since
	// creation, context/create-context.mjs) and, when the session is older, throws SESSION_NOT_FRESH
	// with error.message === error.code's own text ("Session is not fresh"), which is not fit for the
	// screen. Anyone signed in more than a day (the normal case; sessions last a week) hits this every
	// time, so it needs its own actionable state rather than folding into sessionsError's generic
	// string (CUR-963).
	let sessionsNeedsReauth = $state(sessionsStartNotFresh);
	let currentSessionToken = $state<string | null>(initialSession?.session?.token ?? null);
	// The address this account signs in with, shown as typed: the page named every linked provider
	// but never which account a person was actually looking at.
	let signedInEmail = $state<string | null>(initialSession?.user?.email ?? null);
	// The name this account shows on its account menu and to people in a shared workspace.
	// An email-code account starts with none, and a provider account starts with the provider's.
	// An account created without a name can carry its email in the name slot; that is not a name
	// anyone chose, so the field starts empty and the email shows as the placeholder. (CUR-1176)
	const chosenName = (s: SessionResult) => {
		const name = s?.user?.name ?? "";
		return name === (s?.user?.email ?? null) ? "" : name;
	};
	let displayName = $state(chosenName(initialSession));
	let savedName = $state(chosenName(initialSession));
	let nameSaved = $state(false);
	let reauthenticating = $state(false);

	// One key at a time — e.g. "unlink:<id>", "link:google", "add-passkey", "revoke:<sessionId>".
	let busy = $state<string | null>(null);
	let actionError = $state("");

	// "see what Alpha has kept for you, and delete it in two steps". This trigger is the only
	// one that deletes the account (CUR-1420): it opens the shared wipe modal in "account" mode, which
	// asks for a typed confirmation and sends `?account=delete`, so the wipe also removes passkeys,
	// linked providers and sessions. "Forget everything" opens the same modal in "data" mode and leaves
	// the account in place. (CUR-434)
	let deleteAccountBtnEl = $state<HTMLElement>();
	function openDeleteAccount() {
		deleteAllAnchor.set(deleteAccountBtnEl);
		deleteAllMode.set("account");
		deleteAllOpen.set(true);
	}

	async function loadAccounts() {
		const { data: res, error } = await authClient.listAccounts();
		if (error) {
			accountsError = error.message ?? m.account_loadProvidersFailed();
			return;
		}
		accountsError = "";
		accounts = res ?? [];
	}

	async function loadPasskeys() {
		const { data: res, error } = await authClient.passkey.listUserPasskeys();
		if (error) {
			passkeysError = error.message ?? m.account_loadPasskeysFailed();
			return;
		}
		passkeysError = "";
		passkeys = res ?? [];
	}

	async function loadSessions() {
		const { data: res, error } = await authClient.listSessions();
		if (error) {
			if (error.code === "SESSION_NOT_FRESH") {
				sessionsNeedsReauth = true;
				sessionsError = "";
				return;
			}
			sessionsError = error.message ?? m.account_loadSessionsFailed();
			return;
		}
		sessionsNeedsReauth = false;
		sessionsError = "";
		sessions = res ?? [];
	}

	// The only way to satisfy SESSION_NOT_FRESH is a session Better Auth itself considers
	// newly-created — there's no lighter "step up" endpoint for it. Same dual sign-out this app already
	// uses elsewhere (NavMenu.svelte's handleLogout) so it's correct regardless of which auth system
	// this visitor's session came from, then round-trips back here via login's existing `next` param
	// (CUR-960) so a fresh sign-in lands the visitor right back on this list. (CUR-963)
	async function reauthenticate() {
		if (reauthenticating) return;
		reauthenticating = true;
		actionError = "";
		// Better Auth answers a refused sign-out with { error } rather than throwing. Going on to /login
		// with the session still live would bounce straight back here (login's `next`), the same button
		// and no word of why, so a refusal stops here and says so (CUR-4011).
		const result = await authClient.signOut().catch((e: unknown) => ({ error: e }));
		if (result?.error) {
			reauthenticating = false;
			actionError = m.account_signOutRefused();
			return;
		}
		await fetch(`${base}/logout`, { method: "POST" }).catch(() => undefined);
		window.location.href = `${base}/login?next=${encodeURIComponent(page.url.pathname)}`;
	}

	onMount(async () => {
		// The unauthenticated case is handled server-side now (+page.server.ts redirects before this
		// component ever mounts) -- no client-side requireAuthUser() gate needed here.
		// linkSocial needs an errorCallbackURL: without one a failed link (wrong provider email, no
		// email shared, etc.) falls through to Better Auth's default -- the bare app root with a
		// ?error=<code> query string and no page there to read it. So it round-trips back to this
		// page; read the code once, show it, then strip the query string so a refresh
		// doesn't re-show a stale error. (CUR-850)
		const errorCode = page.url.searchParams.get("error");
		if (errorCode) {
			actionError = friendlyAuthErrorMessage(errorCode);
			goto(page.url.pathname, { replaceState: true, noScroll: true, keepFocus: true });
		}
		if (ready) return;
		const sessionPromise = initial.session.ok ? null : authClient.getSession();
		await Promise.all([
			initial.accounts.ok ? null : loadAccounts(),
			initial.passkeys.ok ? null : loadPasskeys(),
			initial.sessions.ok || sessionsStartNotFresh ? null : loadSessions(),
		]);
		if (sessionPromise) {
			const { data: session } = await sessionPromise;
			currentSessionToken = session?.session?.token ?? null;
			signedInEmail = session?.user?.email ?? null;
			savedName = displayName = chosenName(session);
		}
		ready = true;
	});

	let linkedProviderIds = $derived(new Set((accounts ?? []).map((a) => a.providerId)));
	let availableToLink = $derived(
		LINKABLE_PROVIDERS.filter((p) => {
			if (p === "google") return data.providers.google;
			if (p === "github") return data.providers.github;
			return true; // Hugging Face is always configured (betterAuth.ts)
		}).filter((p) => !linkedProviderIds.has(p))
	);

	const DISPLAY_NAME_MAX = 80;

	async function saveDisplayName(event: SubmitEvent) {
		event.preventDefault();
		const name = displayName.trim();
		if (busy || !name || name === savedName) return;
		busy = "name";
		actionError = "";
		nameSaved = false;
		const { error } = await authClient.updateUser({ name });
		if (error) {
			actionError = error.message ?? m.account_saveNameFailed();
			busy = null;
			return;
		}
		savedName = displayName = name;
		nameSaved = true;
		// The account menu reads the name from the layout's user, which the server re-reads per request.
		await invalidateAll();
		busy = null;
	}

	async function linkProvider(provider: (typeof LINKABLE_PROVIDERS)[number]) {
		if (busy) return;
		busy = `link:${provider}`;
		actionError = "";
		const { error } = await authClient.linkSocial({
			provider,
			callbackURL: `${base}/settings/account`,
			errorCallbackURL: `${base}/settings/account`,
		});
		if (error) {
			actionError = error.message ?? m.account_linkFailed({ provider: providerMeta(provider).label });
			busy = null;
			return;
		}
		// On success Better Auth redirects the browser to the provider — nothing else to do here.
	}

	async function unlinkProvider(account: LinkedAccount) {
		if (busy) return;
		busy = `unlink:${account.id}`;
		actionError = "";
		// The request body's `accountId` is the Better Auth ACCOUNT ROW id (account.id below) — a
		// same-named but different field from the response's `accountId` (the provider-side external
		// id). Confirmed against the installed route source (account.mjs): it matches on `account.id`.
		const { error } = await authClient.unlinkAccount({ accountId: account.id });
		busy = null;
		if (error) {
			actionError = error.message ?? m.account_unlinkFailed();
			return;
		}
		await loadAccounts();
	}

	// addPasskey() passes a `name` so each credential renders distinctly instead of as the same
	// literal "Passkey" fallback (line ~365) (CUR-649). No rename-after-creation call exists in Better
	// Auth's client SDK, so whatever name is set here is the only shot. Simpler than an
	// AAGUID-registry lookup: prompt, pre-filled with a suggested browser + OS + date name, editable or
	// clearable before the ceremony starts. A cancelled prompt (null) skips registration entirely; an
	// emptied field falls back to the same suggested name rather than "".
	async function addPasskey() {
		if (busy) return;
		const suggested = suggestedPasskeyName(navigator.userAgent);
		const typed = window.prompt(m.account_namePasskey(), suggested);
		if (typed === null) return;
		const name = typed.trim() || suggested;
		busy = "add-passkey";
		actionError = "";
		const { error } = await authClient.passkey.addPasskey({ name });
		busy = null;
		if (error) {
			actionError = error.message ?? m.account_addPasskeyFailed();
			return;
		}
		await loadPasskeys();
	}

	async function removePasskey(pk: PasskeyRow) {
		if (busy) return;
		busy = `delete-passkey:${pk.id}`;
		actionError = "";
		const { error } = await authClient.passkey.deletePasskey({ id: pk.id });
		busy = null;
		if (error) {
			actionError = error.message ?? m.account_removePasskeyFailed();
			return;
		}
		await loadPasskeys();
	}

	async function revokeSession(sessionRow: SessionRow) {
		if (busy) return;
		busy = `revoke:${sessionRow.id}`;
		actionError = "";
		const { error } = await authClient.revokeSession({ token: sessionRow.token });
		busy = null;
		if (error) {
			actionError = error.message ?? m.account_endSessionFailed();
			return;
		}
		await loadSessions();
	}

	// One export an hour (api/v2/export). The server says when the last one's hour ends; a click on
	// this page starts the hour locally, since the page doesn't reload after a download.
	let exportedAt = $state<Date | null>(null);
	let exportLockedUntil = $derived(
		data.nextExportAt
			? new Date(data.nextExportAt)
			: exportedAt
				? new Date(exportedAt.getTime() + 60 * 60 * 1000)
				: null
	);

	// The Thunderbolt file's own window (CUR-2407): ten minutes, kept apart from the ZIP's hour.
	let thunderboltExportedAt = $state<Date | null>(null);
	let thunderboltLockedUntil = $derived(
		data.nextThunderboltExportAt
			? new Date(data.nextThunderboltExportAt)
			: thunderboltExportedAt
				? new Date(thunderboltExportedAt.getTime() + 10 * 60 * 1000)
				: null
	);

	// What the ZIP will hold, said on the row before anyone downloads it, so a person can see
	// their conversations, files and each answer's provenance are in it without unzipping anything.
	// Until the counts arrive (or if they can't be read) the row keeps its general description. (CUR-2395)
	let exportSummary = $state<{ conversations: number; answers: number; files: number } | null>(
		null
	);
	// The page is server-rendered, so "Add a passkey" is on screen before its click handler exists;
	// held disabled until then, a click that early is refused visibly instead of silently doing nothing.
	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
	});
	onMount(() => {
		if (!page.data.dataExportEnabled) return;
		fetch(`${base}/api/v2/export/summary`)
			.then((r) => (r.ok ? r.json() : null))
			.then((summary) => (exportSummary = summary))
			.catch(() => {});
	});
</script>


<div class="flex w-full flex-col gap-4 type-body text-fg-1">
	<!-- Title comes from the settings layout's PageHeader. -->
	{#if signedInEmail}
		<p
			class="text-center type-caption break-all text-fg-2 md:text-left"
			data-testid="account-email"
		>
			{m.account_signedInAs({ email: signedInEmail })}
		</p>
	{/if}

	{#if actionError}
		<Surface level="2" border="auto" class="px-3 py-2 type-caption">
			{actionError}
		</Surface>
	{/if}

	{#if !ready}
		<!-- CUR-703: shown only while the browser fetches a section +page.server.ts could not read
		     (CUR-2710 moved the four Better Auth reads to the server). -->
		<div class="flex flex-col gap-4" aria-hidden="true">
			{#each Array.from({ length: 3 }) as _, i (i)}
				<div class="flex flex-col gap-2">
					<div class="h-4 w-32 animate-pulse bg-line-2"></div>
					<Surface level="2" border="auto">
						{#each Array.from({ length: 2 }) as _, j (j)}
							<div class="flex h-13 items-center gap-3 border-b border-line-surface px-3 last:border-b-0">
								<div class="size-4 flex-none animate-pulse bg-line-1"></div>
								<div class="h-3 w-40 animate-pulse bg-line-1"></div>
							</div>
						{/each}
					</Surface>
				</div>
			{/each}
		</div>
	{:else}
		<!-- Display name (CUR-1176) -->
		<section class="flex flex-col gap-2">
			<h3 class="type-caption text-fg-2 uppercase">
				<label for="account-display-name">{m.account_displayName()}</label>
			</h3>
			<form class="flex flex-col gap-2 sm:flex-row sm:items-center" onsubmit={saveDisplayName}>
				<Input
					id="account-display-name"
					class="flex-1"
					bind:value={displayName}
					maxlength={DISPLAY_NAME_MAX}
					autocomplete="name"
					placeholder={signedInEmail ?? m.account_yourName()}
					oninput={() => (nameSaved = false)}
				/>
				<Button
					type="submit"
					size="sm"
					casing="sentence"
					disabled={!!busy || !displayName.trim() || displayName.trim() === savedName}
				>
					{busy === "name" ? m.account_saving() : m.settings_save()}
				</Button>
			</form>
			<p class="type-caption text-fg-3" role="status">
				{nameSaved ? m.account_saved() : m.account_displayNameHelp()}
			</p>
		</section>

		<!-- Linked providers -->
		<section class="flex flex-col gap-2">
			<h3 class="type-caption text-fg-2 uppercase">{m.account_linkedProviders()}</h3>
			<Surface level="2" border="auto">
				<!-- Email code signs in any account with an address and nothing can remove it, so it is listed
				     first, without a button, and an email-code-only account never shows "Nothing linked yet."
				     (CUR-3049). -->
				{#if signedInEmail}
					<div
						data-testid="sign-in-method-email"
						class="flex items-center gap-2.5 border-b border-line-surface px-3 py-3 last:border-b-0"
					>
						<RiMailLine class="size-4 flex-none" aria-hidden="true" />
						<div class="min-w-0">
							<div class="truncate type-body text-fg-1">Email code</div>
							<div class="truncate type-caption text-fg-3">{signedInEmail}</div>
							<div class="type-caption text-fg-3">
								You can always sign in with a code sent to this address, so it can’t be removed.
							</div>
						</div>
					</div>
				{/if}
				{#if accountsError}
					<p class="px-3 py-3 type-caption text-fg-1">{accountsError}</p>
				{:else if accounts && accounts.length === 0 && !signedInEmail}
					<p class="px-3 py-3 type-caption text-fg-3">{m.account_nothingLinked()}</p>
				{:else if accounts}
					{#each accounts as account (account.id)}
						{@const meta = providerMeta(account.providerId)}
						<div class="flex items-center justify-between gap-3 border-b border-line-surface px-3 py-3 last:border-b-0">
							<div class="flex min-w-0 items-center gap-2.5">
								<meta.Icon class="size-4 flex-none" />
								<div class="min-w-0">
									<div class="truncate type-body text-fg-1">{meta.label}</div>
									<div class="type-caption text-fg-3">{m.account_linkedOn({ date: fmtDate(account.createdAt) })}</div>
									<!-- The reason Unlink is off is shown here, not only in the button's title, which a disabled
									     button rarely shows and touch never does (CUR-2899). It names the real rule, the last
									     provider (CUR-2794), since the email-code row above says it can always sign in (CUR-3144). -->
									{#if (accounts?.length ?? 0) <= 1}
										<div id="unlink-last-reason-{account.id}" class="type-caption text-fg-3">
											{m.account_lastSignInReason()}
										</div>
									{/if}
								</div>
							</div>
							<Button
								size="sm"
								casing="sentence"
								aria-describedby={(accounts?.length ?? 0) <= 1 ? `unlink-last-reason-${account.id}` : undefined}
								disabled={!!busy || (accounts?.length ?? 0) <= 1}
								title={(accounts?.length ?? 0) <= 1
									? m.account_needOneSignIn()
									: m.account_unlinkProvider({ provider: meta.label })}
								onclick={() => unlinkProvider(account)}
							>
								<RiLinkUnlink aria-hidden="true" />
								<span>{busy === `unlink:${account.id}` ? m.account_unlinking() : m.account_unlink()}</span>
							</Button>
						</div>
					{/each}
				{/if}

				{#each availableToLink as provider (provider)}
					{@const meta = providerMeta(provider)}
					<div class="flex items-center justify-between gap-3 border-b border-line-surface px-3 py-3 last:border-b-0">
						<div class="flex min-w-0 items-center gap-2.5">
							<meta.Icon class="size-4 flex-none" />
							<div class="truncate type-body text-fg-1">{meta.label}</div>
						</div>
						<Button size="sm" casing="sentence" disabled={!!busy} onclick={() => linkProvider(provider)}>
							<RiAddLine aria-hidden="true" />
							<span>{busy === `link:${provider}` ? m.account_redirecting() : m.account_link()}</span>
						</Button>
					</div>
				{/each}
			</Surface>
		</section>

		<!-- Passkeys -->
		<section class="flex flex-col gap-2">
			<h3 class="type-caption text-fg-2 uppercase">{m.account_passkeys()}</h3>
			<Surface level="2" border="auto">
				{#if passkeysError}
					<p class="px-3 py-3 type-caption text-fg-1">{passkeysError}</p>
				{:else if passkeys && passkeys.length === 0}
					<p class="px-3 py-3 type-caption text-fg-3">{m.account_noPasskeys()}</p>
				{:else if passkeys}
					{#each passkeys as pk (pk.id)}
						<div class="flex items-center justify-between gap-3 border-b border-line-surface px-3 py-3 last:border-b-0">
							<div class="flex min-w-0 items-center gap-2.5">
								<RiFingerprintLine class="size-4 flex-none" />
								<div class="min-w-0">
									<div class="truncate type-body text-fg-1">{pk.name || m.account_passkey()}</div>
									<div class="type-caption text-fg-3">
										{deviceTypeLabel(pk.deviceType)} · {m.account_addedOn({ date: fmtDate(pk.createdAt) })}
									</div>
								</div>
							</div>
							<Button size="sm" casing="sentence" disabled={!!busy} onclick={() => removePasskey(pk)}>
								<RiDeleteBinLine aria-hidden="true" />
								<span>{busy === `delete-passkey:${pk.id}` ? m.account_removing() : m.account_remove()}</span>
							</Button>
						</div>
					{/each}
				{/if}
				<div class="px-3 py-3">
					<Button size="sm" casing="sentence" disabled={!hydrated || !!busy} onclick={addPasskey}>
						<RiAddLine aria-hidden="true" />
						<span>{busy === "add-passkey" ? m.account_waitingForDevice() : m.account_addPasskey()}</span>
					</Button>
				</div>
			</Surface>
		</section>

		<!-- Active sessions -->
		<section class="flex flex-col gap-2">
			<h3 class="type-caption text-fg-2 uppercase">{m.account_activeSessions()}</h3>
			<Surface level="2" border="auto">
				{#if sessionsNeedsReauth}
					<div class="flex items-center justify-between gap-3 px-3 py-3">
						<p class="type-caption text-fg-3">
							{m.account_reauthNeeded()}
						</p>
						<Button size="sm" casing="sentence" disabled={reauthenticating} onclick={reauthenticate}>
							<RiLogoutBoxLine aria-hidden="true" />
							<span>{reauthenticating ? m.account_signingOut() : m.account_signInAgain()}</span>
						</Button>
					</div>
				{:else if sessionsError}
					<p class="px-3 py-3 type-caption text-fg-1">{sessionsError}</p>
				{:else if sessions && sessions.length === 0}
					<p class="px-3 py-3 type-caption text-fg-3">{m.account_noSessions()}</p>
				{:else if sessions}
					{#each sessions as sessionRow (sessionRow.id)}
						{@const isCurrent = sessionRow.token === currentSessionToken}
						<div class="flex items-center justify-between gap-3 border-b border-line-surface px-3 py-3 last:border-b-0">
							<div class="flex min-w-0 items-center gap-2.5">
								<RiComputerLine class="size-4 flex-none" />
								<div class="min-w-0">
									<!-- The raw user agent ("Mozilla/5.0 (Windows NT 10.0…") would make two of a person's own
									     browsers look identical, so a platform label leads and the full string stays as the tooltip
									     (CUR-2735). -->
									<div
										class="truncate type-body text-fg-1"
										title={sessionRow.userAgent ?? undefined}
										data-testid="session-device"
									>
										{describePlatform(sessionRow.userAgent ?? "") ?? m.account_unknownDevice()}
									</div>
									<div class="type-caption text-fg-3">
										{sessionRow.ipAddress ?? m.account_unknownIp()} · {m.account_activeOn({ date: fmtDate(sessionRow.updatedAt) })}
									</div>
								</div>
							</div>
							{#if isCurrent}
								<span class="flex-none type-caption text-fg-2">{m.account_thisDevice()}</span>
							{:else}
								<Button size="sm" casing="sentence" disabled={!!busy} onclick={() => revokeSession(sessionRow)}>
									<RiLogoutBoxLine aria-hidden="true" />
									<span>{busy === `revoke:${sessionRow.id}` ? m.account_ending() : m.account_endSession()}</span>
								</Button>
							{/if}
						</div>
					{/each}
				{/if}
			</Surface>
		</section>

		<!-- CUR-434: what's kept + delete-in-two-steps. Conversations are the only stored data today —
		     document/file storage is out of scope until CUR-414 lands a storage path to show. -->
		<section class="flex flex-col gap-2">
			<h3 class="type-caption text-fg-2 uppercase">{m.account_yourData()}</h3>
			<Surface level="2" border="auto">
				{#if page.data.dataExportEnabled && exportLockedUntil}
					<!-- One export an hour. Said here, with the time, rather than letting a second click land
					     on the route's bare 429 page, which has no way back into the app. -->
					<div
						class="flex items-center justify-between gap-3 border-b border-line-surface px-3 py-3"
						data-testid="export-row-locked"
					>
						<div class="min-w-0">
							<div class="truncate type-body text-fg-1">{m.account_downloadData()}</div>
							<div class="type-caption text-fg-3" role="status">
								{m.account_exportLocked({ time: exportLockedUntil.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" }) })}
							</div>
						</div>
						<Button size="sm" casing="sentence" disabled>
							<RiDownload2Line aria-hidden="true" />
							<span>{m.account_download()}</span>
						</Button>
					</div>
				{:else if page.data.dataExportEnabled}
					<!-- CUR-1681. A plain link rather than a fetch: the response is a ZIP with its own
					     Content-Disposition, so the browser handles the download and there is no progress
					     state to invent. Gated on the same boolean the endpoint reads. One export an hour. -->
					<a
						href={`${base}/api/v2/export`}
						data-sveltekit-reload
						class="group flex items-center justify-between gap-3 border-b border-line-surface px-3 py-3 no-underline"
						aria-label={m.account_downloadAria()}
						onclick={() => {
							// After the click's own navigation has started the download; swapping the link
							// out synchronously could cancel it.
							setTimeout(() => (exportedAt = new Date()), 0);
						}}
					>
						<div class="min-w-0">
							<div class="truncate type-body text-fg-1">{m.account_downloadData()}</div>
							<div class="type-caption text-fg-3" data-testid="export-summary">
								{#if exportSummary}
									{m.account_exportSummary({
										conversations: exportSummary.conversations === 1 ? m.account_oneConversation() : m.account_nConversations({ count: exportSummary.conversations }),
										files: exportSummary.files === 1 ? m.account_oneFile() : m.account_nFiles({ count: exportSummary.files }),
										answers: exportSummary.answers === 1 ? m.account_oneAnswerSource() : m.account_nAnswerSources({ count: exportSummary.answers })
									})}
								{:else}
									{m.account_exportGeneric()}
								{/if}
							</div>
						</div>
						<!-- Not a Button: the whole row is the link, and a button nested in a link is invalid.
						     Mirrors the secondary Button skin so it reads as one. -->
						<span
							class="inline-flex h-control-sm flex-none items-center gap-2 border border-line-surface bg-surface-raised px-2.5 type-body text-fg-2 transition-control group-hover:text-fg-1 group-hover:tint-hover rounded-sharp"
						>
							<RiDownload2Line aria-hidden="true" class="size-4" />
							<span>{m.account_download()}</span>
						</span>
					</a>
				{/if}
				{#if page.data.thunderboltExportEnabled && thunderboltLockedUntil}
					<!-- Same reason as the ZIP's locked row: a second click inside the window would land
					     back here with nothing said. -->
					<div
						class="flex items-center justify-between gap-3 border-b border-line-surface px-3 py-3"
						data-testid="thunderbolt-row-locked"
					>
						<div class="min-w-0">
							<div class="truncate type-body text-fg-1">{m.account_thunderboltTitle()}</div>
							<div class="type-caption text-fg-3" role="status">
								{m.account_thunderboltLocked({ time: thunderboltLockedUntil.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" }) })}
							</div>
						</div>
						<Button size="sm" casing="sentence" disabled>
							<RiDownload2Line aria-hidden="true" />
							<span>{m.account_download()}</span>
						</Button>
					</div>
				{:else if page.data.thunderboltExportEnabled}
					<!-- CUR-2407. The same plain-link download as the ZIP above, gated on the boolean
					     api/v2/export/thunderbolt reads. A .json of its own because Thunderbolt's import
					     picker takes nothing else. -->
					<a
						href={`${base}/api/v2/export/thunderbolt`}
						data-sveltekit-reload
						class="group flex items-center justify-between gap-3 border-b border-line-surface px-3 py-3 no-underline"
						aria-label={m.account_thunderboltAria()}
						onclick={() => {
							setTimeout(() => (thunderboltExportedAt = new Date()), 0);
						}}
					>
						<div class="min-w-0">
							<div class="truncate type-body text-fg-1">{m.account_thunderboltTitle()}</div>
							<div class="type-caption text-fg-3">{m.account_thunderboltHelp()}</div>
						</div>
						<span
							class="inline-flex h-control-sm flex-none items-center gap-2 border border-line-surface bg-surface-raised px-2.5 type-body text-fg-2 transition-control group-hover:text-fg-1 group-hover:tint-hover rounded-sharp"
						>
							<RiDownload2Line aria-hidden="true" class="size-4" />
							<span>{m.account_download()}</span>
						</span>
					</a>
				{/if}
				{#if page.data.thunderboltSyncEnabled}
					<!-- CUR-4312: live two-way sync. Connecting starts in Thunderbolt; this row leads to the
					     Connections page that lists it and disconnects it. -->
					<a
						href={`${base}/settings/connections`}
						class="group flex items-center justify-between gap-3 border-b border-line-surface px-3 py-3 no-underline"
						aria-label={m.account_thunderboltSyncAria()}
						data-testid="thunderbolt-sync-row"
					>
						<div class="min-w-0">
							<div class="truncate type-body text-fg-1">{m.account_thunderboltSyncTitle()}</div>
							<div class="type-caption text-fg-3">{m.account_thunderboltSyncHelp()}</div>
						</div>
						<span
							class="inline-flex h-control-sm flex-none items-center gap-2 border border-line-surface bg-surface-raised px-2.5 type-body text-fg-2 transition-control group-hover:text-fg-1 group-hover:tint-hover rounded-sharp"
						>
							<RiLinksLine aria-hidden="true" class="size-4" />
							<span>{m.product_connections()}</span>
						</span>
					</a>
				{/if}
				<DangerRow
					title={m.account_deleteTitle()}
					bind:ref={deleteAccountBtnEl}
					onclick={openDeleteAccount}
					aria-label={m.account_deleteAria()}
				>
					{#snippet description()}{m.account_deleteHelp()}{/snippet}
					<RiDeleteBinFill aria-hidden="true" />
					<span>{m.account_deleteButton()}</span>
				</DangerRow>
			</Surface>
		</section>
	{/if}
</div>
