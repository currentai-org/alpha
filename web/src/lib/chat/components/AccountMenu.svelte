<script lang="ts">
	import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
	import { base } from '$lib/chat/paths';
	import { page } from '$app/state';
	import { dev } from '$app/environment';
	import { goto, invalidate } from '$app/navigation';
	import { m } from '$lib/paraglide/messages.js';
	import { localeName, locales, type Locale } from '$lib/i18n/locales';
	import { setInterfaceLocale } from '$lib/i18n/client.svelte';
	import RiTranslate2 from '~icons/ri/translate-2';
	import { welcomeReplay } from '$lib/chat/stores/welcomeReplay.svelte';
	import { tour } from '$lib/chat/tour/tour.svelte';
	import RiCompass3Line from '~icons/ri/compass-3-line';
	import { Avatar, Menu, Sidebar, getThemeContext, themes, CUSTOM_THEME_ID, type ColorMode } from '@aipotluck/alpha-ds';
	import RiContrast2Line from '~icons/ri/contrast-2-line';
	import RiPaletteLine from '~icons/ri/palette-line';
	import ReportProblemDialog from './ReportProblemDialog.svelte';
	import { startCopyEdit } from '$lib/i18n/copyEdit/entry.svelte';
	import RiEditLine from '~icons/ri/edit-line';
	import DevFlagsDialog from './DevFlagsDialog.svelte';
	import RiToggleLine from '~icons/ri/toggle-line';

	import RiSettings from '~icons/ri/settings-line';
	import RiFlag from '~icons/ri/flag-line';
	import RiFeedbackLine from '~icons/ri/feedback-line';
	import RiShieldCheckLine from '~icons/ri/shield-check-line';
	import RiFileTextLine from '~icons/ri/file-text-line';
	import RiLogin from '~icons/ri/login-box-line';
	import RiLogout from '~icons/ri/logout-box-line';
	import RiUserLine from '~icons/ri/user-line';
	import RiTeamLine from '~icons/ri/team-line';
	import RiMailLine from '~icons/ri/mail-line';
	import RiArrowRightUpLine from '~icons/ri/arrow-right-up-line';
	import RiSparkling2Line from '~icons/ri/sparkling-2-line';
	import { keepLandedNotice } from '$lib/chat/workspaceLandedNotice';
	import PendingInviteRow from './PendingInviteRow.svelte';

	/**
	 * Account menu: one row pinned to the sidebar foot (avatar + name) that opens
	 * everything about *you and the app* — settings, appearance, help/report, policies, sign in/out.
	 * Replaces five loose sidebar rows. The conversation-level actions live in the thread header's
	 * title menu; the GDPR wipe ("Forget everything") is a page, Settings → Data & privacy.
	 */
	let {
		embeddedDemo = false,
		onEmbeddedNavigate,
		onlogout,
		loggingOut = false
	}: {
		embeddedDemo?: boolean;
		onEmbeddedNavigate?: (intent?: EmbeddedIntent) => void;
		onlogout?: () => void;
		loggingOut?: boolean;
	} = $props();
	const interfaceLanguages = locales.map((value) => ({ value, label: localeName(value) }));
	const languageLabel = $derived(interfaceLanguages.find((l) => l.value === page.data.locale)?.label ?? 'English');
	const theme = getThemeContext();
	const user = $derived(page.data.user as { name?: string } | undefined);
	// The /alpha demo has no account: it says so, rather than posing as a guest session.
	const displayName = $derived(user?.name ?? (embeddedDemo ? m.product_demo() : m.product_guest()));
	const initials = $derived(
		displayName
			.split(/\s+/)
			.map((w) => w[0])
			.join('')
			.slice(0, 2) || 'G'
	);

	// With workspaces on, the row's second line says which workspace new conversations count
	// toward; with none active it is the personal one (CUR-1114's name for it). (CUR-3014)
	const currentWorkspace = $derived(page.data.currentWorkspace as { id: string; name: string } | null | undefined);
	// Clears the "landed in Personal" line whenever a team workspace is current (CUR-3089).
	$effect(() => {
		if (currentWorkspace) keepLandedNotice('');
	});
	// A former workspace (left, or deleted) being looked at fills the list with its chats while
	// no team workspace is current, so the row names it rather than saying Personal over them. (CUR-3040)
	const viewingFormer = $derived(page.data.viewingFormer as { id: string; name: string } | null | undefined);
	const workspaceLabel = $derived(
		currentWorkspace?.name ??
			(viewingFormer ? m.workspace_formerItem({ name: viewingFormer.name }) : m.product_personalWorkspace())
	);
	// An invitation waiting on this address, so a signed-in invitee sees it without the email. (CUR-4167)
	const invitations = $derived(
		(page.data.pendingInvitations as { id: string; workspaceName: string; inviterEmail: string }[] | undefined) ?? []
	);
	const invitationLabel = $derived(
		invitations.length === 1
			? m.product_invitationWaiting()
			: m.product_invitationsWaiting({ count: String(invitations.length) })
	);
	const accountStatus = $derived(
		!user
			? m.product_notSignedIn()
			: page.data.workspacesEnabled
				? invitations.length > 0
					? invitationLabel
					: workspaceLabel
				: m.product_signedIn()
	);

	// Switch workspace from here, the way Claude.ai's account menu does, instead of a trip to
	// Settings → Workspace (CUR-3097). Personal is pinned first and is the session with no active
	// workspace, so choosing it unsets the active one.
	const PERSONAL = 'personal';
	const FORMER = 'former:';
	const workspaces = $derived((page.data.workspaces as { id: string; name: string }[] | undefined) ?? []);
	const formerWorkspaces = $derived(
		(page.data.formerWorkspaces as { id: string; name: string }[] | undefined) ?? []
	);
	const shownWorkspace = $derived(
		currentWorkspace?.id ?? (viewingFormer ? FORMER + viewingFormer.id : PERSONAL)
	);
	let menuOpen = $state(false);
	let switchingTo = $state<string | null>(null);
	let switchError = $state('');
	// The group writes its check on click, before the server answers, so a refused switch
	// puts it back on the workspace the person is still in. (CUR-3407)
	let checkedWorkspace = $derived(shownWorkspace);
	// The former-workspace pick is a cookie apart from the session's active workspace, so a switch
	// sets or clears it too; otherwise Personal keeps listing the former workspace's chats.
	async function pickFormer(id: string | null) {
		const res = await fetch(`${base}/api/v2/former-workspace`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id })
		});
		return res.ok;
	}
	async function switchWorkspace(value: string) {
		// Rows stay enabled while a switch runs (greying every row reads as a frozen menu), so a
		// second click is undone here. (CUR-4237)
		if (switchingTo) {
			checkedWorkspace = switchingTo;
			return;
		}
		if (value === shownWorkspace) return;
		switchingTo = value;
		switchError = '';
		const formerId = value.startsWith(FORMER) ? value.slice(FORMER.length) : null;
		try {
			// Loaded on choosing, so the menu every chat page mounts doesn't carry the auth client.
			const { authClient } = await import('$lib/chat/authClient');
			const organizationId = value === PERSONAL || formerId ? null : value;
			if (organizationId !== null || currentWorkspace) {
				const { error } = await authClient.organization.setActive({ organizationId });
				if (error) {
					switchError = error.message ?? m.product_switchWorkspaceFailed();
					checkedWorkspace = shownWorkspace;
					return;
				}
			}
			if ((formerId || viewingFormer) && !(await pickFormer(formerId))) {
				switchError = m.product_switchWorkspaceFailed();
				checkedWorkspace = shownWorkspace;
				await invalidate('app:workspace');
				return;
			}
			// The shell load re-reads the session, so the row's name and the conversation list follow.
			await invalidate('app:workspace');
			// Then get out of the way of the list that just changed (CUR-3174). The items keep
			// closeOnSelect={false} so a failed switch stays open with its reason above.
			menuOpen = false;
		} catch {
			// A stale chunk after a deploy, or a network drop, rejects instead of returning an error.
			switchError = m.product_switchWorkspaceFailed();
			checkedWorkspace = shownWorkspace;
		} finally {
			switchingTo = null;
		}
	}

	// General feedback ("I liked this", "I wish it did that") goes to a Tally form the team
	// owns, apart from "Report a problem", which is for things that are broken or wrong. (CUR-2890)
	const FEEDBACK_FORM_URL = 'https://tally.so/r/QKg85X';

	let reportOpen = $state(false);
	let flagsOpen = $state(false);

	// The guided tour runs over the chat, so from a settings page it goes there first. On the chat it
	// starts as the menu closes, in place of the menu handing focus back to its trigger, which would
	// otherwise take focus straight back from the tour's card.
	let tourOnClose = false;
	async function takeTour() {
		const onChat =
			page.url.pathname.startsWith(`${base}/conversation`) || page.url.pathname.replace(/\/$/, '') === base;
		if (onChat) {
			tourOnClose = true;
			return;
		}
		await goto(`${base}/`);
		setTimeout(() => tour.start('menu'), 300);
	}

	// Dev builds only: replay the first-run intro on a fresh chat, the way a new visitor meets it.
	function replayWelcome() {
		welcomeReplay.open = true;
		void goto(`${base}/`);
	}

	// "Log in" carries the current path as `next` so signing in returns the person to where they were
	// (CUR-1673) — pathname only, since a query can hold `?model=`/`?token=` the entry acts on, and
	// login/+page.server.ts's safeNext() is the one authority on which values are usable. On the login
	// page itself it keeps the page's own `next` rather than pointing sign-in back at itself (CUR-1859).
	const loginHref = $derived.by(() => {
		const loginPath = `${base}/login`;
		if (page.url.pathname.replace(/\/$/, '') === loginPath) {
			const existing = page.url.searchParams.get('next');
			return existing ? `${loginPath}?next=${encodeURIComponent(existing)}` : loginPath;
		}
		return `${loginPath}?next=${encodeURIComponent(page.url.pathname)}`;
	});

	function intercept(e: MouseEvent) {
		if (!embeddedDemo) return;
		e.preventDefault();
		onEmbeddedNavigate?.({ kind: 'app' });
	}

	const modeLabel: Record<ColorMode, string> = $derived({ light: m.product_light(), dark: m.product_dark(), system: m.product_system() });

	// Every theme, plus the person's custom one when saved. `previewId` scopes the swatch's accent.
	const themeList = $derived([
		...themes.map((t) => ({ id: t.id, label: t.label, previewId: t.id })),
		...(theme?.custom ? [{ id: CUSTOM_THEME_ID, label: m.product_custom(), previewId: theme.custom.base }] : [])
	]);
	const currentThemeLabel = $derived(themeList.find((t) => t.id === theme?.theme)?.label ?? 'Alpha');
</script>

<!-- CUR-4237: the clicked workspace row says it heard the click, as Settings → Workspace does. Top level,
     since a snippet inside Menu.Popup would be passed to it as a prop. -->
{#snippet switching(value: string)}
	{#if switchingTo === value}
		<span class="ml-auto flex-none type-caption text-fg-2" role="status">{m.workspace_switching()}</span>
	{/if}
{/snippet}

<!-- Having opened the menu retires the tour hint above it: the person has found where the tour lives.
     Retired as the menu closes: removing it in the same update that opens the menu shut the menu
     again. -->
<Menu.Root
	bind:open={menuOpen}
	onOpenChange={(o) => {
		if (o) return;
		theme?.preview(null);
		tour.dismissHint();
	}}
>
	<Menu.Trigger>
		{#snippet child({ props })}
			<!-- The label is also the accessible name, open rail or collapsed: "signed in as …" is the
			     confirmation a screen-reader user gets that sign-in took. -->
			<Sidebar.Item
				tall
				label={user ? m.product_accountSignedIn({ name: displayName }) : embeddedDemo ? m.product_accountDemo() : m.product_accountGuest()}
				aria-label={user ? m.product_accountSignedIn({ name: displayName }) : embeddedDemo ? m.product_accountDemo() : m.product_accountGuest()}
				triggerProps={{ ...props, 'data-account-trigger': '' }}
			>
				{#snippet leading()}
					<!-- Outside the label, so it stays visible in the collapsed rail. -->
					<Avatar.Root size="sm" class="shrink-0">
						<Avatar.Fallback>{initials}</Avatar.Fallback>
					</Avatar.Root>
				{/snippet}
				<span class="flex min-w-0 flex-col py-0.5 leading-tight">
					<span class="truncate text-fg-1">{displayName}</span>
					{#if embeddedDemo && !user}
						<span class="flex items-center gap-1 truncate type-label text-fg-2">
							{m.product_signup()} <RiArrowRightUpLine aria-hidden="true" class="size-3" />
						</span>
					{:else}
						<span class="truncate type-label text-fg-3" data-account-status>{accountStatus}</span>
					{/if}
				</span>
			</Sidebar.Item>
		{/snippet}
	</Menu.Trigger>
	<Menu.Portal>
		<Menu.Positioner side="top" align="start" sideOffset={6}>
			<Menu.Popup
				class="w-64"
				onCloseAutoFocus={(e) => {
					if (!tourOnClose) return;
					tourOnClose = false;
					e.preventDefault();
					tour.start('menu');
				}}
			>
				<Menu.Group>
					<!-- An email is one unbroken string, so it ends in an ellipsis rather than running out of the
					     menu mid-address (CUR-2217); the full address is its hover text. A group label is set in
					     the UI's label case, which would shout a person's own name or address back at them, so
					     theirs keeps the case they typed. -->
					<Menu.GroupLabel
						class={user ? 'truncate normal-case' : 'truncate'}
						title={user ? displayName : undefined}
						>{user ? displayName : embeddedDemo ? m.product_demoSession() : m.product_guestSession()}</Menu.GroupLabel
					>
					<Menu.LinkItem href={`${base}/settings`} onclick={intercept}>
						<RiSettings aria-hidden="true" /> {m.product_settings()}
					</Menu.LinkItem>
					<!-- Workspaces are organisation-level, so they sit with the account (as in a typical chat app's
					     organisation switcher does), not in the per-chat sidebar. Gated like the page (CUR-913). -->
					{#if page.data.workspacesEnabled && user}
						<Menu.SubmenuRoot onOpenChange={(o) => !o && (switchError = '')}>
							<Menu.SubmenuTrigger>
								<RiTeamLine aria-hidden="true" /> {m.product_workspace()}
								<span class="ml-auto max-w-28 truncate type-caption text-fg-3"
									>{currentWorkspace?.name ??
										(viewingFormer ? m.workspace_formerItem({ name: viewingFormer.name }) : m.product_personal())}</span
								>
							</Menu.SubmenuTrigger>
							<Menu.Portal>
								<Menu.Positioner>
									<Menu.Popup class="w-60" data-workspace-flyout>
										<Menu.RadioGroup bind:value={checkedWorkspace} onValueChange={(v) => void switchWorkspace(v)}>
											<Menu.RadioItem value={PERSONAL} closeOnSelect={false}>
												<span class="truncate">{m.product_personalWorkspace()}</span>
												{@render switching(PERSONAL)}
											</Menu.RadioItem>
											{#each workspaces as w (w.id)}
												<Menu.RadioItem value={w.id} closeOnSelect={false}>
													<span class="truncate">{w.name}</span>
													{@render switching(w.id)}
												</Menu.RadioItem>
											{/each}
											<!-- CUR-3040: below the real ones, as on Settings → Workspace. -->
											{#each formerWorkspaces as w (w.id)}
												<Menu.RadioItem value={FORMER + w.id} closeOnSelect={false}>
													<span class="truncate text-fg-2">{m.workspace_formerItem({ name: w.name })}</span>
													{@render switching(FORMER + w.id)}
												</Menu.RadioItem>
											{/each}
										</Menu.RadioGroup>
										{#if switchError}
											<p role="alert" class="px-2 py-1 type-caption text-fg-2">{switchError}</p>
										{/if}
										{#if invitations.length > 0}
											<Menu.Separator />
											<Menu.Group data-pending-invitations>
												<Menu.GroupLabel>{m.workspace_invitations()}</Menu.GroupLabel>
												{#each invitations as inv (inv.id)}
													<Menu.LinkItem href={`${base}/workspace/accept/${inv.id}`} onclick={intercept}>
														<RiMailLine aria-hidden="true" />
														<PendingInviteRow workspaceName={inv.workspaceName} inviterEmail={inv.inviterEmail} />
													</Menu.LinkItem>
												{/each}
											</Menu.Group>
										{/if}
										<Menu.Separator />
										<Menu.LinkItem href={`${base}/settings/workspace`} onclick={intercept}>
											<RiSettings aria-hidden="true" /> {m.product_manageWorkspaces()}
										</Menu.LinkItem>
									</Menu.Popup>
								</Menu.Positioner>
							</Menu.Portal>
						</Menu.SubmenuRoot>
					{/if}
				</Menu.Group>
				<Menu.Separator />
				<Menu.SubmenuRoot>
					<Menu.SubmenuTrigger data-interface-language>
						<RiTranslate2 aria-hidden="true" /> {m.product_language()}
						<span class="ml-auto type-caption text-fg-3">{languageLabel}</span>
					</Menu.SubmenuTrigger>
					<Menu.Portal>
						<Menu.Positioner>
							<Menu.Popup class="w-44">
								<Menu.RadioGroup value={page.data.locale ?? 'en'} onValueChange={(v) => void setInterfaceLocale(v as Locale)}>
									{#each interfaceLanguages as language (language.value)}
										<Menu.RadioItem value={language.value} closeOnSelect={false} lang={language.value} data-interface-locale={language.value}>
											{language.label}
										</Menu.RadioItem>
									{/each}
								</Menu.RadioGroup>
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.SubmenuRoot>
				<Menu.Separator />
				<Menu.Group>
					<Menu.GroupLabel>{m.product_appearance()}</Menu.GroupLabel>
					<!-- Mode and Theme as flyouts. Hovering (or arrowing to) a theme previews it on the
					     whole window; closing without choosing restores the saved one. -->
					<Menu.SubmenuRoot>
						<Menu.SubmenuTrigger>
							<RiContrast2Line aria-hidden="true" /> {m.product_mode()}
							<span class="ml-auto type-caption text-fg-3">{modeLabel[theme?.mode ?? 'dark']}</span>
						</Menu.SubmenuTrigger>
						<Menu.Portal>
							<Menu.Positioner>
								<Menu.Popup class="w-44">
									<Menu.RadioGroup value={theme?.mode ?? 'dark'} onValueChange={(v) => theme?.setMode(v as ColorMode)}>
										{#each ['light', 'dark', 'system'] as const as m (m)}
											<Menu.RadioItem value={m} closeOnSelect={false}>{modeLabel[m]}</Menu.RadioItem>
										{/each}
									</Menu.RadioGroup>
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.SubmenuRoot>
					<Menu.SubmenuRoot onOpenChange={(o) => !o && theme?.preview(null)}>
						<Menu.SubmenuTrigger>
							<RiPaletteLine aria-hidden="true" /> {m.product_theme()}
							<span class="ml-auto truncate type-caption text-fg-3">{currentThemeLabel}</span>
						</Menu.SubmenuTrigger>
						<Menu.Portal>
							<Menu.Positioner>
								<Menu.Popup class="w-56" data-theme-flyout>
									<Menu.RadioGroup value={theme?.theme ?? 'alpha'} onValueChange={(v) => theme?.setTheme(v)}>
										{#each themeList as t (t.id)}
											<Menu.RadioItem
												value={t.id}
												closeOnSelect={false}
												onmouseenter={() => theme?.preview(t.id)}
												onfocus={() => theme?.preview(t.id)}
												data-theme-option={t.id}
											>
												<span class="flex items-center gap-2">
													<span
														data-ds-theme={t.previewId}
														class="size-3.5 shrink-0 border border-line-2 bg-accent-1 rounded-pill"
														aria-hidden="true"
													></span>
													{t.label}
												</span>
											</Menu.RadioItem>
										{/each}
									</Menu.RadioGroup>
									<Menu.Separator />
									<Menu.LinkItem href={`${base}/settings/appearance`} onclick={intercept}>
										<RiSettings aria-hidden="true" /> {m.product_moreAppearance()}
									</Menu.LinkItem>
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.SubmenuRoot>
				</Menu.Group>
				<Menu.Separator />
				<Menu.Group>
					<Menu.GroupLabel>{m.product_help()}</Menu.GroupLabel>
					{#if !embeddedDemo}
						<Menu.Item onSelect={takeTour} data-take-tour>
							<RiCompass3Line aria-hidden="true" /> {m.tour_take()}
						</Menu.Item>
					{/if}
					<!-- Not in the /alpha demo: there's no real session to report on, and the sample
					     answers aren't Alpha's to be judged on. -->
					{#if !embeddedDemo}
						<Menu.Item onSelect={() => (reportOpen = true)}>
							<RiFlag aria-hidden="true" /> {m.product_reportProblem()}
						</Menu.Item>
						<Menu.LinkItem href={FEEDBACK_FORM_URL} target="_blank">
							<RiFeedbackLine aria-hidden="true" /> {m.product_giveFeedback()}
							<RiArrowRightUpLine aria-hidden="true" class="ml-auto" />
						</Menu.LinkItem>
					{/if}
					<Menu.LinkItem href={`${base}/privacy-notice`} onclick={intercept}>
						<RiFileTextLine aria-hidden="true" /> {m.product_privacyNotice()}
					</Menu.LinkItem>
					<Menu.LinkItem href={`${base}/trust-and-safety`} onclick={intercept}>
						<RiShieldCheckLine aria-hidden="true" /> {m.product_trustSafety()}
					</Menu.LinkItem>
					{#if __COPY_EDIT__ && !embeddedDemo}
						<Menu.Item onSelect={() => void startCopyEdit()} data-dev-edit-text>
							<RiEditLine aria-hidden="true" /> Edit text
							<span class="ml-auto type-caption text-fg-3">Dev</span>
						</Menu.Item>
					{/if}
					{#if dev && !embeddedDemo}
						<Menu.Item onSelect={replayWelcome} data-dev-meet-alpha>
							<RiSparkling2Line aria-hidden="true" /> {m.product_meetAlpha()}
							<span class="ml-auto type-caption text-fg-3">Dev</span>
						</Menu.Item>
						<Menu.Item onSelect={() => (flagsOpen = true)} data-dev-feature-flags>
							<RiToggleLine aria-hidden="true" /> {m.product_featureFlags()}
							<span class="ml-auto type-caption text-fg-3">Dev</span>
						</Menu.Item>
					{/if}
				</Menu.Group>
				{#if embeddedDemo && !user}
					<!-- Demo: the account row is the way in, so the menu ends on one big Sign up. -->
					<Menu.Separator />
					<Menu.Item tone="cta" onSelect={() => onEmbeddedNavigate?.({ kind: 'signup' })} data-demo-signup-cta>
						{m.product_signup()} <RiArrowRightUpLine aria-hidden="true" />
					</Menu.Item>
				{:else if page.data.loginEnabled}
					<Menu.Separator />
					{#if user}
						<Menu.LinkItem href={`${base}/settings/account`} onclick={intercept}>
							<RiUserLine aria-hidden="true" /> {m.product_account()}
						</Menu.LinkItem>
						<Menu.Item disabled={loggingOut} onSelect={() => onlogout?.()}>
							<RiLogout aria-hidden="true" />
							{loggingOut ? m.product_loggingOut() : m.product_logout()}
						</Menu.Item>
					{:else}
						<Menu.LinkItem href={loginHref} onclick={intercept}>
							<RiLogin aria-hidden="true" /> {m.product_login()}
						</Menu.LinkItem>
					{/if}
				{/if}
			</Menu.Popup>
		</Menu.Positioner>
	</Menu.Portal>
</Menu.Root>

{#if !embeddedDemo}<ReportProblemDialog bind:open={reportOpen} />{/if}
{#if dev && !embeddedDemo}<DevFlagsDialog bind:open={flagsOpen} />{/if}
