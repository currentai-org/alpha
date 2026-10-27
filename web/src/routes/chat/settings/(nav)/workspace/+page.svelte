<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime.js';
	// Workspaces (CUR-550): one person brings Alpha into a group without us doing it by hand. Create a
	// workspace, invite people by email, remove them, see who's joined. Built on Better Auth's
	// organization plugin (betterAuth.ts): every call below is the same generic path-proxy
	// account/+page.svelte uses for listAccounts/listSessions/etc, and
	// `authClient.organization.inviteMember(...)` resolves to `/organization/invite-member` per the
	// installed package's own route declarations.
	//
	// creatorRole is "admin" (betterAuth.ts), so the plugin's built-in "owner" role is never assigned
	// or shown anywhere here; this UI only offers "admin" and "member". A brand-new workspace's creator
	// becomes its admin automatically; every invite is sent as "member", and an admin changes a
	// member's role afterwards from that member's row (CUR-1685).
	//
	// Joining by request is not built. The joinMethod SWITCH (CUR-826) is only stored and displayed; the only
	// way in is an admin's email invite regardless of what the switch reads, since no request/open
	// join flow exists to act on the other two values.
	//
	// The "Workspace rules" section renders for every member, not just admins, because members can
	// always see the rules that govern them (CUR-826). Labels come from workspacePermissions.ts, never
	// a restated string, so a switch this page doesn't anticipate still renders as its raw value
	// rather than silently vanishing.
	//
	// Switching workspace uses Better Auth's OWN active-organization concept
	// (session.activeOrganizationId, set via /organization/set-active), not page-local state
	// (CUR-553). It is scoped to THIS page and its own heading: there is no nav-wide or chat-wide
	// "current workspace" indicator, and nothing in chat itself reads activeOrganizationId, so
	// switching here does not re-scope any prompt/document/model behavior (no workspace-scoped content
	// exists to re-scope). A personal account with zero workspaces stays exactly that; nothing
	// auto-provisions a "workspace of one" for it.
	//
	// An admin never sees the content of a member's conversations (CUR-552). The
	// /settings/workspace/usage endpoint enforces it (workspaceUsage.ts only ever selects aggregate
	// scalars, never `doc`), not this component. There is no per-conversation view anywhere on this
	// page, on purpose: a conversation's title is usually a model-generated summary of its first
	// message, so a "recent conversations" list would leak content through a field that looks like
	// metadata.
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { invalidate } from "$app/navigation";
	import { base } from "$lib/chat/paths";
	import { authClient } from "$lib/chat/authClient";
	import { ORGANIZATION_ERROR_CODES } from "better-auth/client/plugins";
	import {
		joinMethodLabel,
		configChangeRuleLabel,
		WORKSPACE_NAME_MAX,
	} from "$lib/chat/workspacePermissions";
	// The rule labels are translated here; workspacePermissions.ts stays free of interface copy because
	// the database schema imports it.
	const JOIN_METHOD_COPY: Record<string, () => string> = {
		invitation: m.workspace_joinInvitation,
		request: m.workspace_joinRequest,
		open: m.workspace_joinOpen
	};
	const CONFIG_RULE_COPY: Record<string, () => string> = {
		admin_only: m.workspace_ruleAdminOnly,
		members_propose_admin_approves: m.workspace_ruleProposeApprove,
		members_propose_auto_apply: m.workspace_ruleProposeAuto
	};
	import { keepLandedNotice, keptLandedNotice } from "$lib/chat/workspaceLandedNotice";
	import { providerMeta } from "$lib/chat/authProviderMeta";
	import {
		SIGNED_OUT_COPY,
		isSignedOut,
		pageErrorText,
		resolveOrganizationsState,
		type OrgRow
	} from "./orgsState";
	import RiAddLine from "~icons/ri/add-line";
	import RiMailSendLine from "~icons/ri/mail-send-line";
	import RiDeleteBinLine from "~icons/ri/delete-bin-line";
	import RiCloseLine from "~icons/ri/close-line";
	import RiTeamLine from "~icons/ri/team-line";
	import RiUserLine from "~icons/ri/user-line";
	import RiArchiveLine from "~icons/ri/archive-line";
	import RiShieldUserLine from "~icons/ri/shield-user-line";
	import RiPencilLine from "~icons/ri/pencil-line";
	import RiLogoutBoxRLine from "~icons/ri/logout-box-r-line";
	import PendingInviteRow, { inviteName } from "$lib/chat/components/PendingInviteRow.svelte";

	type MemberRow = {
		id: string;
		userId: string;
		role: string;
		createdAt: string | Date;
		user: { id: string; name: string; email: string };
	};
	type InvitationRow = {
		id: string;
		email: string;
		role: string;
		status: string;
		expiresAt: string | Date;
	};
	type FullOrg = OrgRow & { members: MemberRow[]; invitations: InvitationRow[] };
	type MemberUsage = {
		userId: string;
		conversationCount: number;
		messageCount: number;
		lastActiveAt: string | null;
	};
	type WorkspaceUsage = {
		totalConversations: number;
		totalMessages: number;
		activeMemberCount: number;
		perMember: MemberUsage[];
		documentCount: number;
	};

	const SLUG_TAKEN_CODES = new Set<string>([
		ORGANIZATION_ERROR_CODES.ORGANIZATION_ALREADY_EXISTS.code,
		ORGANIZATION_ERROR_CODES.ORGANIZATION_SLUG_ALREADY_TAKEN.code,
	]);

	// Better Auth speaks of organizations and owners; this page has workspaces and admins (CUR-2835).
	function memberErrorCopy(code: string | undefined, action: "remove" | "leave" = "remove"): string | null {
		switch (code) {
			case ORGANIZATION_ERROR_CODES.YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER.code:
			case ORGANIZATION_ERROR_CODES.YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER.code:
				return action === "leave"
					? m.workspace_onlyAdminLeave()
					: m.workspace_onlyAdmin();
			// Any address already in the workspace, the inviter's own included, so the copy names no one. (CUR-3053)
			case ORGANIZATION_ERROR_CODES.USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION.code:
				return m.workspace_alreadyMember();
			case ORGANIZATION_ERROR_CODES.USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION.code:
				return m.workspace_alreadyInvited();
			default:
				return null;
		}
	}

	function slugify(name: string): string {
		const base = name
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 50);
		return base || "workspace";
	}

	function fmtDate(d: string | Date) {
		return new Date(d).toLocaleDateString(getLocale(), { year: "numeric", month: "short", day: "numeric" });
	}

	function fmtLastActive(d: string | null) {
		return d ? fmtDate(d) : m.workspace_never();
	}

	let ready = $state(false);
	let currentUserId = $state<string | null>(null);
	// The account record this deployment's personal-workspace view is rendered from when org
	// creation is off — never a real organization row (no schema change), just the session's own name/
	// email, the same fields the real member-list already shows for "(you)". (CUR-957)
	let myAccountName = $state<string | null>(null);
	let myAccountEmail = $state<string | null>(null);
	// Which provider(s) actually authenticate this account, for the zero-org identity badge
	// below — the name/email alone can't distinguish a GitHub sign-in from Google or email/password. (CUR-1175)
	let myAccountProviders = $state<string[]>([]);
	let orgs = $state<OrgRow[] | null>(null);
	let orgsError = $state("");
	let selectedOrgId = $state<string | null>(null);
	let activeOrgId = $state<string | null>(null);
	let switchError = $state("");
	let full = $state<FullOrg | null>(null);
	let fullError = $state("");
	// Once any request comes back 401 the session is gone, and every control on the page
	// would fail the same way, so the page shows the signed-out notice and a way to sign in instead. (CUR-4108)
	let signedOut = $state(false);
	const loginHref = $derived(`${base}/login?next=${encodeURIComponent(page.url.pathname)}`);
	// The account row at the foot of the sidebar names the signed-in person unless the chat shell's
	// load re-runs. Re-running it reads the ended session, so the row says guest beside the notice
	// (CUR-4108).
	$effect(() => {
		if (signedOut) invalidate("app:workspace").catch(() => {});
	});

	function errorText(error: { status?: number; message?: string }, fallback: string) {
		if (isSignedOut(error)) signedOut = true;
		return pageErrorText(error, fallback);
	}
	let usage = $state<WorkspaceUsage | null>(null);
	let usageError = $state("");

	let showCreateForm = $state(false);
	let newWorkspaceName = $state("");
	let createError = $state("");

	let inviteEmail = $state("");
	let inviteError = $state("");

	// One key at a time — "create", "invite", "remove:<memberId>", "cancel:<invitationId>", "delete-workspace".
	let busy = $state<string | null>(null);
	let actionError = $state("");

	// A refused invite, Leave or member action re-renders the page, and the refusal line can land below
	// the fold while the person looks at the button. Each refusal line scrolls itself into view as it
	// appears and is announced, so the answer is where they look (CUR-3207). Centred, not "nearest",
	// which parks it flush against the bottom edge, half cut off (CUR-4060).
	function revealRefusal(node: HTMLElement) {
		node.scrollIntoView({ block: "center" });
	}

	// admin-triggered whole-workspace delete. Two steps — reveal, then require typing the
	// workspace's own name — since this destroys OTHER members' access and pending invitations, not just
	// the admin's own data (the bar DeleteAllConversationsModal's single click sets for a self-only wipe). (CUR-827)
	let confirmingDelete = $state(false);
	let deleteConfirmText = $state("");
	let deleteError = $state("");

	// With org creation off, every /organization/* route is refused categorically for the deployment,
	// so the list call cannot succeed. Calling it anyway and branching on its error would land a
	// zero-org visitor on the {:else if orgsError} template branch (a bare error string) instead of
	// the zero-org personal-workspace view that exists for this case (CUR-957). The enabled/disabled
	// branch is decided by resolveOrganizationsState (orgsState.ts, unit-tested), not inline here, so
	// that decision stays covered without mounting this whole page.
	async function loadOrganizations() {
		applyOrganizations(await fetchOrganizations());
	}

	// The list on its own, unapplied, so a create or rename can show it in the same step as the rest of
	// the page. Applied early, the new or renamed row would show while the heading and Current mark still
	// described the old state (CUR-3948, CUR-3960).
	async function fetchOrganizations() {
		if (!page.data.workspaceOrgCreationEnabled) {
			return resolveOrganizationsState(false);
		}
		// Better Auth's own client-side Organization type doesn't know about the CUR-826 additionalFields
		// (declared server-side only, in betterAuth.ts) — the values are there at runtime, this app's own
		// OrgRow type is the accurate one.
		const result = (await authClient.organization.list()) as unknown as {
			data: OrgRow[] | null;
			error: { status?: number; message?: string } | null;
		};
		if (isSignedOut(result.error)) signedOut = true;
		return resolveOrganizationsState(true, result);
	}

	function applyOrganizations(state: ReturnType<typeof resolveOrganizationsState>) {
		({ orgs, orgsError } = state);
	}

	async function loadFull(organizationId: string) {
		applyFull(await fetchFull(organizationId));
	}

	// A dropped connection rejects instead of answering with an error. Both read the same to the
	// person, and neither may escape: the switch that called this has already been saved (CUR-3373).
	function fetchFull(organizationId: string) {
		return authClient.organization
			.getFullOrganization({ query: { organizationId } })
			.catch(() => ({ data: null, error: { message: undefined } }));
	}

	function applyFull({ data, error }: Awaited<ReturnType<typeof fetchFull>>) {
		fullError = "";
		if (error) {
			fullError = errorText(error, m.workspace_loadFailed());
			full = null;
			usage = null;
			return;
		}
		full = (data as unknown as FullOrg | null) ?? null;
		const me = full?.members.find((m) => m.userId === currentUserId);
		const meIsAdmin = me?.role?.split(",").includes("admin") ?? false;
		if (meIsAdmin && full) {
			// NOT awaited: awaiting it would block loadFull's own promise — and, through it, onMount's
			// `ready` flip — behind a third sequential round trip (org list, then org detail, then this
			// aggregate usage query) on top of an already-blank cold-load tab with no skeleton visible until
			// hydration finishes. The Usage section below already has its own "Loading…" fallback (it's
			// admin-only and per-org, unlike the member list ready gates), so there's nothing for the rest of
			// the page to wait on here (CUR-963).
			void loadUsage(full.id);
		} else {
			usage = null;
			usageError = "";
		}
	}

	// "counts only" — this endpoint independently re-checks the caller is an admin of THIS
	// organization server-side (not just this page choosing not to show the button), so a 403 here
	// means the caller genuinely isn't one, not that the UI merely hid the section. (CUR-552)
	async function loadUsage(organizationId: string) {
		usageError = "";
		try {
			const res = await fetch(
				`${base}/settings/workspace/usage?organizationId=${encodeURIComponent(organizationId)}`
			);
			if (!res.ok) {
				usage = null;
				if (res.status !== 403) usageError = m.usage_failed();
				return;
			}
			usage = await res.json();
		} catch {
			usage = null;
			usageError = m.usage_failed();
		}
	}

	// Views a workspace's detail WITHOUT changing which one is active — used for the initial load, so
	// opening this page never silently switches you. switchTo (below) is the deliberate "I choose this
	// one" gesture.
	async function selectOrg(id: string) {
		selectedOrgId = id;
		renaming = false;
		renameError = "";
		confirmingLeave = false;
		leaveError = "";
		await loadFull(id);
	}

	// The panel describes the current workspace and nothing else, so the list's Current badge
	// and the panel never name different workspaces. Under Personal there is no team detail to show. (CUR-3373)
	async function showCurrent() {
		if (activeOrgId) {
			await selectOrg(activeOrgId);
			return;
		}
		selectedOrgId = null;
		full = null;
		fullError = "";
		usage = null;
	}

	// "switch, and have everything follow" — the deliberate gesture. Calls Better Auth's own
	// /organization/set-active (not just local UI state) so activeOrganizationId is the actual source of
	// truth other surfaces can read later, not something only this page's memory knows about. (CUR-553)
	async function switchTo(id: string) {
		if (busy || id === activeOrgId) {
			await selectOrg(id);
			return;
		}
		busy = `switch:${id}`;
		switchError = "";
		try {
			const { error } = await authClient.organization.setActive({ organizationId: id });
			if (error) {
				switchError = errorText(error, m.workspace_switchFailed());
				return;
			}
			setLandedNotice("");
			if (viewingFormerId) await pickFormer(null);
			// The row highlight, the Current badge, the panel and the account row's name all
			// change in one step, once the detail and the chat shell have both loaded. The clicked row
			// stays disabled until then. A failed detail load still moves them, because the server has
			// already switched (CUR-3373). (CUR-3462)
			shellAskedFor = id;
			const [detail] = await Promise.all([
				fetchFull(id),
				invalidate("app:workspace").catch(() => {})
			]);
			renaming = false;
			renameError = "";
			confirmingLeave = false;
			leaveError = "";
			selectedOrgId = id;
			activeOrgId = id;
			applyFull(detail);
		} finally {
			busy = null;
		}
	}

	// Personal is the session with no active workspace, so choosing it unsets the active one. (CUR-3020)
	async function switchToPersonal() {
		if (busy || (activeOrgId === null && viewingFormerId === null)) return;
		busy = "switch:personal";
		switchError = "";
		if (activeOrgId !== null) {
			const { error } = await authClient.organization.setActive({ organizationId: null });
			if (error) {
				busy = null;
				switchError = errorText(error, m.workspace_switchPersonalFailed());
				return;
			}
			// As in switchTo, Current and the account row move together, once the chat shell has reloaded,
			// so Current never moves while the account row still names the team (CUR-3462).
			shellAskedFor = null;
			await invalidate("app:workspace").catch(() => {});
			activeOrgId = null;
		}
		if (viewingFormerId) await pickFormer(null);
		await showCurrent();
		busy = null;
		setLandedNotice("");
	}

	// Chats from a workspace this person left, or that was deleted, list under that former
	// workspace instead of in Personal. Looking at one is a Personal session plus a pick the server
	// keeps in a cookie, so it is read-only by construction: no team workspace is active. (CUR-3040)
	type FormerWorkspaceRow = { id: string; name: string; kind: "left" | "deleted" };
	let formerWorkspaces = $derived((page.data.formerWorkspaces ?? []) as FormerWorkspaceRow[]);
	let viewingFormerId = $state<string | null>((page.data.viewingFormerId as string | null) ?? null);

	// Invitations waiting on this person's own address (not the ones this workspace sent,
	// which are `pendingInvitations`). Open goes to the accept page; Decline answers it here. (CUR-4167)
	type InviteToMe = { id: string; workspaceName: string; inviterEmail: string };
	let invitesToMe = $derived((page.data.pendingInvitations ?? []) as InviteToMe[]);
	let decliningInvite = $state<string | null>(null);
	let declineInviteError = $state("");
	async function declineInvite(id: string) {
		if (decliningInvite) return;
		decliningInvite = id;
		declineInviteError = "";
		try {
			const { error } = await authClient.organization.rejectInvitation({ invitationId: id });
			if (error) {
				declineInviteError = error.message ?? m.workspace_declineInviteFailed();
				return;
			}
			await invalidate("app:workspace");
		} catch {
			declineInviteError = m.workspace_declineInviteFailed();
		} finally {
			decliningInvite = null;
		}
	}

	async function pickFormer(id: string | null): Promise<boolean> {
		const res = await fetch(`${base}/api/v2/former-workspace`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
		if (!res.ok) {
			switchError = m.workspace_openChatsFailed();
			return false;
		}
		viewingFormerId = id;
		void invalidate("app:workspace");
		return true;
	}

	async function viewFormer(id: string) {
		if (busy || id === viewingFormerId) return;
		busy = `former:${id}`;
		switchError = "";
		if (activeOrgId !== null) {
			const { error } = await authClient.organization.setActive({ organizationId: null });
			if (error) {
				busy = null;
				switchError = errorText(error, m.workspace_openChatsFailed());
				return;
			}
			activeOrgId = null;
		}
		await pickFormer(id);
		await showCurrent();
		busy = null;
		setLandedNotice("");
	}

	// Losing the current workspace (deleted, or this person removed from it) lands them in
	// Personal with a line saying why. Another team workspace is never picked for them. (CUR-3022)
	let landedNotice = $state("");
	function setLandedNotice(notice: string) {
		landedNotice = notice;
		keepLandedNotice(notice);
	}
	// The session's workspace is gone with its name, so this notice can't say which one it was.
	const LOST_WORKSPACE_NOTICE =
		m.workspace_landedPersonal();
	async function fallBackToPersonal(notice: string) {
		const { error } = await authClient.organization.setActive({ organizationId: null });
		activeOrgId = null;
		if (error) {
			switchError = errorText(error, m.workspace_switchPersonalFailed());
			return;
		}
		setLandedNotice(notice);
	}

	// The account menu names the current workspace from the chat shell's load. Once this
	// page knows the active workspace, re-run that load whenever it changes (a switch, a create, a
	// delete), asking at most once per change so a load that disagrees can never loop. (CUR-3014)
	let activeOrgKnown = $state(false);
	let shellAskedFor: string | null | undefined = undefined;
	$effect(() => {
		if (!activeOrgKnown) return;
		const id = activeOrgId;
		const shown = (page.data.currentWorkspace as { id: string } | null | undefined)?.id ?? null;
		if (shellAskedFor === undefined) {
			shellAskedFor = shown;
		}
		if (id === shellAskedFor) return;
		shellAskedFor = id;
		void invalidate("app:workspace");
	});

	onMount(async () => {
		const sessionPromise = authClient.getSession();
		// Fired alongside, not awaited until after loadOrganizations() — same "don't serialize what
		// doesn't depend on each other" shape sessionPromise already uses. Only the zero-org view (below)
		// ever reads this, but every visitor pays the request either way rather than branching on
		// page.data.workspaceOrgCreationEnabled here, since a workspace admin can still lose their last
		// org mid-session and land on this view without a reload.
		const accountsPromise = authClient.listAccounts();
		await loadOrganizations();
		const { data: session } = await sessionPromise;
		currentUserId = session?.user?.id ?? null;
		myAccountName = session?.user?.name ?? null;
		myAccountEmail = session?.user?.email ?? null;
		const { data: accounts } = await accountsPromise;
		myAccountProviders = accounts?.map((a) => a.providerId) ?? [];
		activeOrgId =
			(session?.session as { activeOrganizationId?: string | null } | undefined)
				?.activeOrganizationId ?? null;
		activeOrgKnown = true;
		if (activeOrgId === null) landedNotice = keptLandedNotice();
		else setLandedNotice("");
		if (orgs && orgs.length > 0) {
			// Prefer the session's own active org (if it's still one of ours) over "just pick the first
			// one" — a returning visitor should land back where they left off, not always at index 0.
			const stillMine = activeOrgId && orgs.some((o) => o.id === activeOrgId);
			if (stillMine) {
				await selectOrg(activeOrgId!);
			} else if (!activeOrgId) {
				// No active workspace means Personal, which is where every session starts.
				// Leave the person there; the panel says so rather than showing a team's detail (CUR-3373). (CUR-3020)
				await showCurrent();
			} else {
				// The session's workspace was deleted or this person was removed from it (CUR-2835), so
				// they land in Personal (CUR-3022).
				await fallBackToPersonal(LOST_WORKSPACE_NOTICE);
				await showCurrent();
			}
		} else {
			// No team workspace left, yet the session still names one: it was this person's last, and it
			// was deleted or they were removed from it. Land in Personal and say why here too.
			if (activeOrgId) await fallBackToPersonal(LOST_WORKSPACE_NOTICE);
			if (page.data.workspaceOrgCreationEnabled) {
			// Org creation is on for this deployment (preview) — unchanged behaviour, the same
			// "create a workspace" prompt this page has always shown a zero-org visitor. (CUR-957)
				showCreateForm = true;
			}
		}
		// else: org creation is off (production) — the template's zero-org branch renders the personal
		// workspace view straight from myAccountName/myAccountEmail above; nothing else to fetch.
		ready = true;
	});

	let myMember = $derived(full?.members.find((m) => m.userId === currentUserId) ?? null);
	// Join order, so a role change never moves a row under the admin's next click (CUR-2906). The server
	// returns members unordered, and an update can change where a row comes back.
	let membersInJoinOrder = $derived(
		[...(full?.members ?? [])].sort(
			(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id),
		),
	);
	let isAdmin = $derived(myMember?.role?.split(",").includes("admin") ?? false);
	// Better Auth refuses the last admin's Leave, so that person is told up front instead of
	// being offered a Leave that answers "Leaving…" and then a refusal. (CUR-4020)
	let soleAdmin = $derived(
		isAdmin && (full?.members.filter((m) => m.role?.split(",").includes("admin")).length ?? 0) === 1,
	);
	let pendingInvitations = $derived(full?.invitations.filter((i) => i.status === "pending") ?? []);
	let usageByUserId = $derived(new Map((usage?.perMember ?? []).map((m) => [m.userId, m])));

	async function createWorkspace() {
		if (busy) return;
		const name = newWorkspaceName.trim();
		if (!name) return;
		busy = "create";
		createError = "";
		let slug = slugify(name);
		// A slug collision is the only failure worth retrying automatically — the admin never chose the
		// slug, so asking them to pick a different one for a collision they can't see would be strange.
		for (let attempt = 0; attempt < 3; attempt++) {
			const { data: created, error } = await authClient.organization.create({ name, slug });
			if (!error) {
				// As in switchTo, the new row's highlight, its Current badge, the heading and the account row
				// move in one step, once the list, the detail and the chat shell have all loaded (CUR-3462).
				// Lighting the row first would leave Personal still marked Current for a moment.
				// Better Auth makes a freshly created workspace active (no keepCurrentActiveOrganization
				// override here), so this mirrors that locally rather than re-deriving it from a second call
				// (CUR-553). The form keeps reading "Creating…" until then.
				if (created?.id) shellAskedFor = created.id;
				const [listed, detail] = await Promise.all([
					fetchOrganizations(),
					created?.id ? fetchFull(created.id) : null,
					created?.id ? invalidate("app:workspace").catch(() => {}) : null
				]);
				// Collapse the create form only once the reloaded list already contains the new workspace —
				// flipping this BEFORE the await would leave a frame where the form was gone and `orgs` was
				// still the pre-create (often empty) list, rendering as a bare "+ New workspace" button with
				// nothing to suggest the create had worked (CUR-1560). The typed name is cleared here too, not
				// before the await: clearing it first would blank the field to its placeholder while the button
				// still read "Creating…".
				newWorkspaceName = "";
				showCreateForm = false;
				busy = null;
				applyOrganizations(listed);
				if (created?.id && detail) {
					renaming = false;
					renameError = "";
					confirmingLeave = false;
					leaveError = "";
					selectedOrgId = created.id;
					activeOrgId = created.id;
					applyFull(detail);
				}
				return;
			}
			// Slugs are shared across every account, and create answers a taken one with
			// ORGANIZATION_ALREADY_EXISTS; only /check-slug says SLUG_ALREADY_TAKEN (CUR-2835).
			if (SLUG_TAKEN_CODES.has(error.code ?? "") && attempt < 2) {
				slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
				continue;
			}
			createError = errorText(error, m.workspace_createFailed());
			busy = null;
			return;
		}
	}

	async function inviteMember() {
		if (busy || !selectedOrgId) return;
		const email = inviteEmail.trim();
		if (!email) return;
		busy = "invite";
		inviteError = "";
		const { error } = await authClient.organization.inviteMember({
			organizationId: selectedOrgId,
			email,
			role: "member",
		});
		busy = null;
		if (error) {
			inviteError = memberErrorCopy(error.code) ?? errorText(error, m.workspace_inviteFailed());
			return;
		}
		inviteEmail = "";
		await loadFull(selectedOrgId);
	}

	// Remove asks first, naming the person, the way Leave and Delete do. It is offered on
	// other members' rows only; Leave is how anyone takes themselves out. (CUR-3385)
	let confirmingRemove = $state<string | null>(null);
	async function removeMember(member: MemberRow) {
		if (busy || !selectedOrgId) return;
		busy = `remove:${member.id}`;
		actionError = "";
		const { error } = await authClient.organization.removeMember({
			organizationId: selectedOrgId,
			memberIdOrEmail: member.id,
		});
		if (error) {
			busy = null;
			actionError = memberErrorCopy(error.code) ?? errorText(error, m.workspace_removeFailed());
			return;
		}
		confirmingRemove = null;
		await loadFull(selectedOrgId);
		busy = null;
	}

	// An admin gives another member the admin role, or takes it back. Because creatorRole is
	// "admin" (betterAuth.ts), Better Auth's /organization/update-member-role lets an admin set and
	// clear "admin" on others and refuses to leave a workspace with no admin. The control is offered on
	// other members' rows only, so nobody demotes themselves by accident. (CUR-1685)
	async function setMemberRole(member: MemberRow, role: "admin" | "member") {
		if (busy || !selectedOrgId) return;
		busy = `role:${member.id}`;
		actionError = "";
		const { error } = await authClient.organization.updateMemberRole({
			organizationId: selectedOrgId,
			memberId: member.id,
			role,
		});
		if (error) {
			busy = null;
			actionError = errorText(error, m.workspace_roleFailed());
			return;
		}
		await loadFull(selectedOrgId);
		busy = null;
	}

	async function cancelInvitation(inv: InvitationRow) {
		if (busy || !selectedOrgId) return;
		busy = `cancel:${inv.id}`;
		actionError = "";
		const { error } = await authClient.organization.cancelInvitation({ invitationId: inv.id });
		if (error) {
			busy = null;
			actionError = errorText(error, m.workspace_cancelInviteFailed());
			return;
		}
		await loadFull(selectedOrgId);
		busy = null;
	}

	// Deletes the organization row — Postgres cascades member + invitation rows itself
	// (schema.ts's onDelete:"cascade" on both), so nothing here needs to delete those explicitly. (CUR-827)
	async function deleteWorkspace() {
		if (busy || !selectedOrgId || !full || deleteConfirmText.trim() !== full.name) return;
		busy = "delete-workspace";
		deleteError = "";
		const { error } = await authClient.organization.delete({ organizationId: selectedOrgId });
		busy = null;
		if (error) {
			deleteError = errorText(error, m.workspace_deleteFailed());
			return;
		}
		confirmingDelete = false;
		deleteConfirmText = "";
		const wasActive = selectedOrgId === activeOrgId;
		const deletedName = full.name;
		selectedOrgId = null;
		full = null;
		// Deleting the current workspace lands in Personal, never the next team workspace. (CUR-3022)
		if (wasActive) await fallBackToPersonal(`${deletedName} was deleted. You're in your personal workspace.`);
		await loadOrganizations();
		if (orgs && orgs.length > 0) {
			await showCurrent();
		} else {
			showCreateForm = true;
		}
	}

	// An admin renames the workspace. Our admin role carries Better Auth's organization:update
	// (betterAuth.ts, CUR-827), and the account menu's label follows through the shell load. (CUR-3106)
	let renaming = $state(false);
	let renameText = $state("");
	let renameError = $state("");
	async function renameWorkspace() {
		if (busy || !selectedOrgId || !full) return;
		const name = renameText.trim();
		if (!name) {
			renameError = m.workspace_nameRequired();
			return;
		}
		if (name === full.name) {
			renaming = false;
			return;
		}
		busy = "rename";
		renameError = "";
		const { error } = await authClient.organization.update({
			organizationId: selectedOrgId,
			data: { name },
		});
		if (error) {
			busy = null;
			renameError = errorText(error, m.workspace_renameFailed());
			return;
		}
		// The field keeps the new name and the button "Saving…" until the list, the heading and the
		// account row can all show it (CUR-3960). Closing the form first would put the old name back for
		// a moment, which reads as a rename that failed.
		const [listed, detail] = await Promise.all([
			fetchOrganizations(),
			fetchFull(selectedOrgId),
			invalidate("app:workspace").catch(() => {}),
		]);
		applyOrganizations(listed);
		applyFull(detail);
		renaming = false;
		busy = null;
	}

	// Any member leaves. Better Auth refuses the last admin, and when the workspace was the
	// current one it unsets it, so the person lands in Personal the way CUR-3022 does. (CUR-3106)
	let confirmingLeave = $state(false);
	let leaveError = $state("");
	async function leaveWorkspace() {
		if (busy || !selectedOrgId || !full) return;
		busy = "leave";
		leaveError = "";
		const { error } = await authClient.organization.leave({ organizationId: selectedOrgId });
		busy = null;
		if (error) {
			leaveError = memberErrorCopy(error.code, "leave") ?? errorText(error, m.workspace_leaveFailed());
			return;
		}
		confirmingLeave = false;
		const wasActive = selectedOrgId === activeOrgId;
		const leftName = full.name;
		selectedOrgId = null;
		full = null;
		if (wasActive) await fallBackToPersonal(m.workspace_leftNowPersonal({ name: leftName }));
		else landedNotice = m.workspace_left({ name: leftName });
		await loadOrganizations();
		if (orgs && orgs.length > 0) {
			await showCurrent();
		} else {
			showCreateForm = true;
		}
		// The account menu's workspace list drops the one just left, current or not.
		void invalidate("app:workspace");
	}

	const cardClass = "border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] rounded-card";
	const rowButtonClass =
		"flex h-8 flex-none items-center gap-1.5 border border-[var(--ap-border-2)] bg-[var(--ap-paper-3)] px-2.5 text-left text-[length:var(--ap-text-2)] text-[color:var(--ap-ink)] transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40";
	const inputClass =
		"w-full border border-[var(--ap-border-2)] bg-[var(--ap-paper-3)] px-3 py-1.5 text-[length:var(--ap-text-2)] text-[color:var(--ap-ink)] placeholder:text-[color:var(--ap-ink-3)] outline-hidden focus-visible:ring-2";
</script>

{#snippet switchNotices()}
	{#if switchError}
		<p class="px-3 py-2 text-[length:var(--ap-text-2)]">{switchError}</p>
	{/if}
	{#if landedNotice}
		<p role="status" class="px-3 py-2 type-body text-fg-2">{landedNotice}</p>
	{/if}
{/snippet}


<div class="flex w-full flex-col gap-4 text-[length:var(--ap-text-3)] text-[color:var(--ap-ink)]">
	<!-- "Workspace" comes from the settings layout's PageHeader; the active org's name stays here. -->
	{#if signedOut}
		<!-- CUR-4108: no workspace name over the signed-out notice. -->
	{:else if full && selectedOrgId === activeOrgId}
		<h2 class="type-heading text-fg-1">{full.name}</h2>
	{:else if ready && orgs && orgs.length > 0 && activeOrgId === null}
		<!-- CUR-3462: the heading slot stays filled under Personal, so a switch never moves the list
		     out from under the pointer that made it. -->
		<h2 class="type-heading text-fg-1">
			{formerWorkspaces.find((w) => w.id === viewingFormerId)?.name ?? m.product_personalWorkspace()}
		</h2>
	{/if}

	{#if actionError && !signedOut}
		<p
			role="alert"
			use:revealRefusal
			class="border border-[var(--ap-border-2)] bg-[var(--ap-paper-2)] px-3 py-2 text-[length:var(--ap-text-2)] rounded-card"
		>
			{actionError}
		</p>
	{/if}

	{#if !ready}
		<div class="flex flex-col gap-2" aria-hidden="true">
			<div class="h-[15px] w-32 animate-pulse bg-[var(--ap-rule)]/60"></div>
			<div class={cardClass}>
				{#each Array.from({ length: 2 }) as _, j (j)}
					<div class="flex h-[52px] items-center gap-3 border-b border-[var(--ap-border-1)] px-3 last:border-b-0">
						<div class="size-4 flex-none animate-pulse bg-[var(--ap-rule)]/40"></div>
						<div class="h-3 w-40 animate-pulse bg-[var(--ap-rule)]/40"></div>
					</div>
				{/each}
			</div>
		</div>
	{:else if signedOut}
		<div role="alert" class="flex flex-wrap items-center justify-between gap-3 px-3 py-3 {cardClass}">
			<p class="type-body">{SIGNED_OUT_COPY}</p>
			<a href={loginHref} class={rowButtonClass}>{m.product_signIn()}</a>
		</div>
	{:else if orgsError}
		<p class="px-3 py-3 text-[length:var(--ap-text-2)]">{orgsError}</p>
	{:else}
		{#if invitesToMe.length > 0}
			<section class="flex flex-col gap-2" data-invitations-to-me>
				<h3 class="type-caption text-fg-2 uppercase">{m.workspace_invitations()}</h3>
				<p class="type-body text-fg-2">{m.workspace_invitationsHelp()}</p>
				{#if declineInviteError}
					<p role="alert" class="type-caption text-fg-2">{declineInviteError}</p>
				{/if}
				<div class={cardClass}>
					{#each invitesToMe as inv (inv.id)}
						<div class="flex items-center justify-between gap-2.5 border-b border-line-1 px-3 py-3 last:border-b-0">
							<PendingInviteRow workspaceName={inv.workspaceName} inviterEmail={inv.inviterEmail} />
							<span class="flex flex-none gap-2">
								<a
									href={`${base}/workspace/accept/${inv.id}`}
									class={rowButtonClass}
									aria-label={`${m.workspace_openInvite()}: ${inviteName(inv.workspaceName)}`}
								>{m.workspace_openInvite()}</a>
								<button
									type="button"
									class={rowButtonClass}
									aria-label={`${m.workspace_declineInvite()}: ${inviteName(inv.workspaceName)}`}
									disabled={decliningInvite !== null}
									onclick={() => declineInvite(inv.id)}>{m.workspace_declineInvite()}</button
								>
							</span>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- CUR-553: every workspace, always — "see all of their workspaces... without hunting for them in
		     a menu" — not gated on having more than one, so a single-workspace member still sees the
		     "you're in X" confirmation this list doubles as. -->
		{#if orgs && orgs.length > 0}
			<section class="flex flex-col gap-2">
				<h3 class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-2)] uppercase">{m.workspace_yourWorkspaces()}</h3>
				<!-- CUR-3023: switching changes the conversation list, so say so where the switch is. -->
				<p class="type-body text-fg-2">{m.workspace_ownConversations()}</p>
				{@render switchNotices()}
				<div class={cardClass}>
					<button
						type="button"
						class="flex w-full items-center justify-between gap-2.5 border-b border-line-1 px-3 py-3 text-left hover:bg-tint-hover"
						disabled={busy === "switch:personal"}
						onclick={switchToPersonal}
					>
						<span class="flex min-w-0 items-center gap-2.5">
							<RiUserLine class="size-4 flex-none" />
							<span class="truncate type-body">{m.product_personalWorkspace()}</span>
						</span>
						{#if activeOrgId === null && viewingFormerId === null}
							<span class="flex-none type-caption text-fg-2 uppercase">{m.workspace_current()}</span>
						{:else if busy === "switch:personal"}
							<!-- CUR-3462: Current stays on the team until the shell reloads, so without this the
							     pointer's hover fill on Personal read as a second selection. -->
							<span class="flex-none type-caption text-fg-2" role="status"
								>{m.workspace_switching()}</span
							>
						{/if}
					</button>
					{#each orgs as org (org.id)}
						<button
							type="button"
							class="flex w-full items-center justify-between gap-2.5 border-b border-[var(--ap-border-1)] px-3 py-3 text-left last:border-b-0 hover:bg-white/10 {org.id === selectedOrgId ? 'bg-white/15' : ''}"
							disabled={busy === `switch:${org.id}`}
							onclick={() => switchTo(org.id)}
						>
							<span class="flex min-w-0 items-center gap-2.5">
								<RiTeamLine class="size-4 flex-none" />
								<span class="truncate text-[length:var(--ap-text-3)]">{org.name}</span>
							</span>
							{#if org.id === activeOrgId}
								<span class="flex-none text-[length:var(--ap-text-1)] text-[color:var(--ap-ink-2)] uppercase"
									>{m.workspace_current()}</span
								>
							{:else if busy === `switch:${org.id}`}
								<!-- CUR-3462: the highlight and badge wait for the new workspace to load, so the
								     clicked row says it heard the click. -->
								<span class="flex-none type-caption text-fg-2" role="status"
									>{m.workspace_switching()}</span
								>
							{/if}
						</button>
					{/each}
				</div>
			</section>
		{:else}
			<!-- With no team workspace left, the list above is gone, but the reason for landing in
			     Personal (the last one deleted, or this person removed from it) still has to show. -->
			{@render switchNotices()}
		{/if}

		<!-- CUR-3040: shown with or without a team workspace, since a person whose only one was deleted
		     still has its chats. -->
		{#if formerWorkspaces.length > 0}
			<section class="flex flex-col gap-2">
				<h3 class="type-caption text-fg-2 uppercase">{m.workspace_former()}</h3>
				<p class="type-body text-fg-2">
					{m.workspace_formerHelp()}
				</p>
				<div class={cardClass}>
					{#each formerWorkspaces as w (w.id)}
						<button
							type="button"
							class="flex w-full items-center justify-between gap-2.5 border-b border-line-1 px-3 py-3 text-left last:border-b-0 hover:bg-tint-hover"
							disabled={busy === `former:${w.id}`}
							onclick={() => viewFormer(w.id)}
						>
							<span class="flex min-w-0 items-center gap-2.5">
								<RiArchiveLine class="size-4 flex-none" />
								<span class="truncate type-body">{m.workspace_formerItem({ name: w.name })}</span>
							</span>
							{#if w.id === viewingFormerId}
								<span class="flex-none type-caption text-fg-2 uppercase">{m.workspace_viewing()}</span>
							{/if}
						</button>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Current workspace detail -->
		{#if selectedOrgId}
			{#if fullError}
				<!-- CUR-4026: a failed detail load says what to do next. The switch itself was saved, so asking
				     again is the whole recovery. -->
				<div class="flex items-center justify-between gap-3 px-3 py-3">
					<p class="text-[length:var(--ap-text-2)]">{fullError}</p>
					<button
						type="button"
						class={rowButtonClass}
						disabled={!!busy}
						onclick={() => selectedOrgId && loadFull(selectedOrgId)}
					>
						{m.message_tryAgain()}
					</button>
				</div>
			{:else if full}
				{#if isAdmin}
					<!-- CUR-3106: an admin fixes the workspace's name in place, rather than deleting and starting over. -->
					<section class="flex flex-col gap-2">
						<h3 class="text-small text-fg-2 uppercase">{m.workspace_nameHeading()}</h3>
						<div class={cardClass}>
							{#if !renaming}
								<div class="flex items-center justify-between gap-3 px-3 py-3">
									<span class="truncate text-body">{full.name}</span>
									<button
										type="button"
										class={rowButtonClass}
										disabled={!!busy}
										onclick={() => {
											renameText = full?.name ?? "";
											renameError = "";
											renaming = true;
										}}
									>
										<RiPencilLine class="size-3.5" />
										<span>{m.workspace_rename()}</span>
									</button>
								</div>
							{:else}
								<form
									class="flex flex-col gap-2.5 px-3 py-3"
									onsubmit={(e) => {
										e.preventDefault();
										void renameWorkspace();
									}}
								>
									<label class="flex flex-col gap-1 text-small text-fg-3">
										{m.workspace_nameLabel()}
										<input type="text" bind:value={renameText} maxlength={WORKSPACE_NAME_MAX} class={inputClass} />
									</label>
									{#if renameError}
										<p class="text-small">{renameError}</p>
									{/if}
									<div class="flex gap-2">
										<button type="submit" class={rowButtonClass} disabled={busy === "rename"}>
											{busy === "rename" ? m.account_saving() : m.workspace_saveName()}
										</button>
										<button
											type="button"
											class={rowButtonClass}
											disabled={busy === "rename"}
											onclick={() => {
												renaming = false;
												renameError = "";
											}}
										>
											{m.message_cancel()}
										</button>
									</div>
								</form>
							{/if}
						</div>
					</section>
				{/if}

				<section class="flex flex-col gap-2">
					<h3 class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-2)] uppercase">
						{m.workspace_rules()}
					</h3>
					<div class={cardClass}>
						<div class="flex items-center justify-between gap-3 border-b border-[var(--ap-border-1)] px-3 py-3">
							<span class="text-[length:var(--ap-text-3)] text-[color:var(--ap-ink-3)]">{m.workspace_howJoin()}</span>
							<span class="text-[length:var(--ap-text-3)]">{JOIN_METHOD_COPY[full.joinMethod]?.() ?? joinMethodLabel(full.joinMethod)}</span>
						</div>
						<div class="flex items-center justify-between gap-3 px-3 py-3">
							<span class="text-[length:var(--ap-text-3)] text-[color:var(--ap-ink-3)]">{m.workspace_whoCanChange()}</span>
							<span class="text-[length:var(--ap-text-3)]">{CONFIG_RULE_COPY[full.configChangeRule]?.() ?? configChangeRuleLabel(full.configChangeRule)}</span>
						</div>
					</div>
				</section>

				<!-- CUR-826: the section above is unconditional — every member, not just admins, "always"
				     sees the rules that govern them (the third switch). -->
				<section class="flex flex-col gap-2">
					<h3 class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-2)] uppercase">
						{m.workspace_members({ name: full.name })}
					</h3>
					<div class={cardClass}>
						{#each membersInJoinOrder as member (member.id)}
							<div
								data-testid="workspace-member"
								class="flex items-center justify-between gap-3 border-b border-[var(--ap-border-1)] px-3 py-3 last:border-b-0">
				<div class="min-w-0">
									<div class="truncate text-[length:var(--ap-text-3)]">
										{member.user.name || member.user.email}
										{#if member.userId === currentUserId}
											<span class="text-[color:var(--ap-ink-3)]">{m.workspace_you()}</span>
										{/if}
									</div>
									<div class="text-[length:var(--ap-text-1)] text-[color:var(--ap-ink-3)]">
										{member.user.email} · {member.role.split(",").includes("admin") ? m.workspace_admin() : m.workspace_member()}
									</div>
									<!-- CUR-552: counts only — no per-conversation content, just this row's own totals. -->
									{#if isAdmin && usageByUserId.get(member.userId)}
										{@const u = usageByUserId.get(member.userId)}
										<div class="text-[length:var(--ap-text-1)] text-[color:var(--ap-ink-3)]">
											{u?.conversationCount === 1 ? m.account_oneConversation() : m.account_nConversations({ count: u?.conversationCount ?? 0 })} ·
											{u?.messageCount === 1 ? m.usage_oneMessage() : m.usage_nMessages({ count: u?.messageCount ?? 0 })} ·
											{m.workspace_lastActive({ date: fmtLastActive(u?.lastActiveAt ?? null) })}
										</div>
									{/if}
								</div>
								{#if isAdmin}
									{@const memberIsAdmin = member.role.split(",").includes("admin")}
									<div class="flex flex-none items-center gap-2">
										{#if member.userId !== currentUserId}
											<button
												type="button"
												class={rowButtonClass}
												disabled={!!busy}
												aria-label={`${memberIsAdmin ? m.workspace_makeMember() : m.workspace_makeAdmin()}: ${member.user.name || member.user.email}`}
												onclick={() => setMemberRole(member, memberIsAdmin ? "member" : "admin")}
											>
												<RiShieldUserLine class="size-3.5" />
												<span
													>{busy === `role:${member.id}`
														? m.account_saving()
														: memberIsAdmin
															? m.workspace_makeMember()
															: m.workspace_makeAdmin()}</span
												>
											</button>
											<button
												type="button"
												class={rowButtonClass}
												disabled={!!busy}
												aria-label={m.workspace_removeMemberAria({ name: member.user.name || member.user.email })}
												aria-expanded={confirmingRemove === member.id}
												onclick={() => {
													actionError = "";
													confirmingRemove = member.id;
												}}
											>
												<RiDeleteBinLine class="size-3.5" />
												<span>{m.workspace_removeEllipsis()}</span>
											</button>
										{/if}
									</div>
								{/if}
							</div>
							{#if isAdmin && confirmingRemove === member.id}
								<div
									data-testid="workspace-remove-confirm"
									class="flex flex-col gap-2.5 border-b border-line-1 px-3 py-3 last:border-b-0">
									<p class="text-small">
										{#each m.workspace_removeConfirm({ name: "{name}", workspace: "{workspace}" }).split(/(\{name\}|\{workspace\})/).filter(Boolean) as part, i (i)}{#if part === "{name}"}<strong>{member.user.name || member.user.email}</strong>{:else if part === "{workspace}"}<strong>{full.name}</strong>{:else}{part}{/if}{/each}
									</p>
									<div class="flex gap-2">
										<button
											type="button"
											class={rowButtonClass}
											disabled={busy === `remove:${member.id}`}
											onclick={() => removeMember(member)}
										>
											{busy === `remove:${member.id}` ? m.account_removing() : m.account_remove()}
										</button>
										<button
											type="button"
											class={rowButtonClass}
											disabled={busy === `remove:${member.id}`}
											onclick={() => (confirmingRemove = null)}
										>
											{m.message_cancel()}
										</button>
									</div>
								</div>
							{/if}
						{/each}
					</div>
				</section>

				{#if isAdmin}
					<!-- CUR-552: "counts only... an admin never sees the content of a member's conversations."
					     No per-conversation row anywhere here, on purpose — see this file's own header comment. -->
					<section class="flex flex-col gap-2">
						<h3 class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-2)] uppercase">{m.workspace_usage()}</h3>
						<div class={cardClass}>
							{#if usageError}
								<p class="px-3 py-3 text-[length:var(--ap-text-2)]">{usageError}</p>
							{:else if usage}
								<div class="flex items-center justify-between gap-3 border-b border-[var(--ap-border-1)] px-3 py-3">
									<span class="text-[length:var(--ap-text-3)] text-[color:var(--ap-ink-3)]">{m.usage_conversations()}</span>
									<span class="text-[length:var(--ap-text-3)]">{usage.totalConversations}</span>
								</div>
								<div class="flex items-center justify-between gap-3 border-b border-[var(--ap-border-1)] px-3 py-3">
									<span class="text-[length:var(--ap-text-3)] text-[color:var(--ap-ink-3)]">{m.usage_messages()}</span>
									<span class="text-[length:var(--ap-text-3)]">{usage.totalMessages}</span>
								</div>
								<div class="flex items-center justify-between gap-3 px-3 py-3">
									<span class="text-[length:var(--ap-text-3)] text-[color:var(--ap-ink-3)]"
										>{m.workspace_active30()}</span
									>
									<span class="text-[length:var(--ap-text-3)]"
										>{m.usage_ofMax({ value: String(usage.activeMemberCount), max: String(full.members.length) })}</span
									>
								</div>
							{:else}
								<p class="px-3 py-3 text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-3)]">{m.workspace_loading()}</p>
							{/if}
						</div>
					</section>

					<!-- CUR-957: gated on workspaceOrgCreationEnabled, not just isAdmin — inviting anyone must
					     be unreachable by screen in production regardless of how this org came to exist. -->
					{#if page.data.workspaceOrgCreationEnabled}
					<section class="flex flex-col gap-2">
						<h3 class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-2)] uppercase">{m.workspace_inviteByEmail()}</h3>
						<div class={cardClass}>
							<form
								class="flex items-center gap-2 px-3 py-3"
								onsubmit={(e) => {
									e.preventDefault();
									inviteMember();
								}}
							>
								<input
									type="email"
									required
									placeholder="name@example.org"
									bind:value={inviteEmail}
									class={inputClass}
								/>
								<button type="submit" class={rowButtonClass} disabled={!!busy}>
									<RiMailSendLine class="size-3.5" />
									<span>{busy === "invite" ? m.report_sending() : m.workspace_invite()}</span>
								</button>
							</form>
							{#if inviteError}
								<p
									role="alert"
									use:revealRefusal
									class="border-t border-[var(--ap-border-1)] px-3 py-2 text-[length:var(--ap-text-2)]"
								>
									{inviteError}
								</p>
							{/if}
						</div>
					</section>
					{/if}

					{#if page.data.workspaceOrgCreationEnabled && pendingInvitations.length > 0}
						<section class="flex flex-col gap-2">
							<h3 class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-2)] uppercase">
								{m.workspace_pendingInvitations()}
							</h3>
							<div class={cardClass}>
								{#each pendingInvitations as inv (inv.id)}
									<div class="flex items-center justify-between gap-3 border-b border-[var(--ap-border-1)] px-3 py-3 last:border-b-0">
										<div class="min-w-0">
											<div class="truncate text-[length:var(--ap-text-3)]">{inv.email}</div>
											<div class="text-[length:var(--ap-text-1)] text-[color:var(--ap-ink-3)]">
												{m.workspace_expires({ date: fmtDate(inv.expiresAt) })}
											</div>
										</div>
										<button
											type="button"
											class={rowButtonClass}
											disabled={!!busy}
											onclick={() => cancelInvitation(inv)}
										>
											<RiCloseLine class="size-3.5" />
											<span>{busy === `cancel:${inv.id}` ? m.workspace_cancelling() : m.message_cancel()}</span>
										</button>
									</div>
								{/each}
							</div>
						</section>
					{/if}

					<!-- CUR-827: admin-triggered whole-workspace delete. -->
					<section class="flex flex-col gap-2">
						<h3 class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-2)] uppercase">{m.workspace_dangerZone()}</h3>
						<div class={cardClass}>
							{#if !confirmingDelete}
								<div class="flex items-center justify-between gap-3 px-3 py-3">
									<span class="text-[length:var(--ap-text-3)] text-[color:var(--ap-ink-3)]">
										{m.workspace_deleteRow({ name: full.name })}
									</span>
									<button
										type="button"
										class={rowButtonClass}
										disabled={!!busy}
										onclick={() => (confirmingDelete = true)}
									>
										<RiDeleteBinLine class="size-3.5" />
										<span>{m.workspace_deleteEllipsis()}</span>
									</button>
								</div>
							{:else}
								<div class="flex flex-col gap-2.5 px-3 py-3">
									<p class="text-[length:var(--ap-text-2)]">
										{#each (full.members.length === 1 ? m.workspace_deleteWarningOne({ name: "{name}" }) : m.workspace_deleteWarningMany({ name: "{name}", count: full.members.length })).split(/(\{name\})/).filter(Boolean) as part, i (i)}{#if part === "{name}"}<strong>{full.name}</strong>{:else}{part}{/if}{/each}
										{#if usage && usage.documentCount > 0}{usage.documentCount === 1 ? m.workspace_deleteDocsOne() : m.workspace_deleteDocsMany({ count: usage.documentCount })}{/if}
										{m.workspace_deleteClosing()}
									</p>
									<label class="flex flex-col gap-1 text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-3)]">
										{#each m.workspace_typeToConfirm({ name: "{name}" }).split(/(\{name\})/).filter(Boolean) as part, i (i)}{#if part === "{name}"}<strong class="text-[color:var(--ap-ink)]">{full.name}</strong>{:else}{part}{/if}{/each}
										<input
											type="text"
											bind:value={deleteConfirmText}
											placeholder={full.name}
											class={inputClass}
										/>
									</label>
									{#if deleteError}
										<p class="text-[length:var(--ap-text-2)]">{deleteError}</p>
									{/if}
									<div class="flex gap-2">
										<button
											type="button"
											class="flex h-8 flex-none items-center gap-1.5 border border-[var(--ap-border-2)] bg-[var(--ap-danger)] px-2.5 text-[length:var(--ap-text-2)] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
											disabled={deleteConfirmText.trim() !== full.name || busy === "delete-workspace"}
											onclick={deleteWorkspace}
										>
											{busy === "delete-workspace" ? m.workspace_deleting() : m.workspace_delete()}
										</button>
										<button
											type="button"
											class={rowButtonClass}
											disabled={busy === "delete-workspace"}
											onclick={() => {
												confirmingDelete = false;
												deleteConfirmText = "";
												deleteError = "";
											}}
										>
											{m.message_cancel()}
										</button>
									</div>
								</div>
							{/if}
						</div>
					</section>
				{/if}

				<!-- CUR-3106: every member, admin or not, can take themselves out of a workspace. -->
				<section class="flex flex-col gap-2">
					<h3 class="text-small text-fg-2 uppercase">{m.workspace_leaveHeading()}</h3>
					<div class={cardClass}>
						{#if soleAdmin && !confirmingLeave}
							<p class="px-3 py-3 text-body text-fg-3">{m.workspace_onlyAdminLeave()}</p>
						{:else if !confirmingLeave}
							<div class="flex items-center justify-between gap-3 px-3 py-3">
								<span class="text-body text-fg-3">
									{m.workspace_stopBeing({ name: full.name })}
								</span>
								<button
									type="button"
									class={rowButtonClass}
									disabled={!!busy}
									onclick={() => {
										leaveError = "";
										confirmingLeave = true;
									}}
								>
									<RiLogoutBoxRLine class="size-3.5" />
									<span>{m.workspace_leaveEllipsis()}</span>
								</button>
							</div>
						{:else}
							<div class="flex flex-col gap-2.5 px-3 py-3">
								<!-- CUR-4020: once Leave is refused, the "you'll stop being a member" line would contradict
								     the refusal, so the refusal takes its place. -->
								{#if leaveError}
									<p role="alert" use:revealRefusal class="text-small">{leaveError}</p>
								{:else}
									<p class="text-small">
										{#each m.workspace_leaveConfirm({ workspace: "{workspace}" }).split(/(\{workspace\})/).filter(Boolean) as part, i (i)}{#if part === "{workspace}"}<strong>{full.name}</strong>{:else}{part}{/if}{/each}
									</p>
								{/if}
								<div class="flex gap-2">
									<!-- The only-admin refusal offers no second try, since it names what has to change first;
									     a failed request still can be retried. -->
									{#if leaveError !== m.workspace_onlyAdminLeave()}
										<button
											type="button"
											class={rowButtonClass}
											disabled={busy === "leave"}
											onclick={leaveWorkspace}
										>
											{busy === "leave" ? m.workspace_leaving() : m.workspace_leave()}
										</button>
									{/if}
									<button
										type="button"
										class={rowButtonClass}
										disabled={busy === "leave"}
										onclick={() => {
											confirmingLeave = false;
											leaveError = "";
										}}
									>
										{m.message_cancel()}
									</button>
								</div>
							</div>
						{/if}
					</div>
				</section>
			{/if}
		{:else if activeOrgId === null && viewingFormerId === null && orgs && orgs.length > 0}
			<p class="px-3 py-3 type-body text-fg-3">
				{m.workspace_inPersonal()}
			</p>
		{/if}

		<!-- CUR-957: zero orgs, and org creation is off for this deployment (production) — the personal
		     workspace view, rendered straight from the account record (no schema change, no organization
		     row exists). Name + email only; the real "Workspace rules"/members/usage sections above read
		     fields an actual organization row carries, which this account-derived view doesn't have and
		     must not fabricate — the rest of "your account settings" already lives on this Settings nav's
		     other tabs. -->
		{#if orgs && orgs.length === 0 && !page.data.workspaceOrgCreationEnabled}
			<section class="flex flex-col gap-2">
				<h3 class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-2)] uppercase">
					{m.workspace_yourWorkspace()}
				</h3>
				<div class={cardClass}>
					<div class="flex items-center gap-2.5 px-3 py-3">
						<RiTeamLine class="size-4 flex-none" />
						<div class="min-w-0">
							<div class="truncate text-[length:var(--ap-text-3)]">
								{myAccountName || myAccountEmail || m.workspace_yourWorkspace()}
							</div>
							{#if myAccountName && myAccountEmail}
								<div class="text-[length:var(--ap-text-1)] text-[color:var(--ap-ink-3)]">
									{myAccountEmail}
								</div>
							{/if}
							<!-- CUR-1175: name/email alone can't tell you HOW you're signed in — a GitHub sign-in
							     looked identical to an email/password one. Same PROVIDER_META the Account tab's
							     "Linked providers" list already uses, so this can never drift out of sync with it. -->
							{#if myAccountProviders.length > 0}
								<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
									{#each myAccountProviders as providerId (providerId)}
										{@const meta = providerMeta(providerId)}
										<span
											class="flex items-center gap-1 text-[length:var(--ap-text-1)] text-[color:var(--ap-ink-3)]"
										>
											<meta.Icon class="size-3" />
											{meta.label}
										</span>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				</div>
			</section>
		{/if}

		<!-- Create another workspace — CUR-957: gated separately from workspacesEnabled above (this
		     section is entirely about the org-creation privilege, not seeing your own workspace), so it
		     stays hidden in production even once the personal view is live. -->
		{#if page.data.workspaceOrgCreationEnabled}
			<section class="flex flex-col gap-2">
				{#if !showCreateForm}
					<button
						type="button"
						class="{rowButtonClass} w-fit"
						onclick={() => (showCreateForm = true)}
					>
						<RiAddLine class="size-3.5" />
						<span>{m.workspace_new()}</span>
					</button>
				{:else}
					<h3 class="text-[length:var(--ap-text-2)] text-[color:var(--ap-ink-2)] uppercase">
						{orgs && orgs.length > 0 ? m.workspace_createAnother() : m.workspace_createOne()}
					</h3>
					<div class={cardClass}>
						<form
							class="flex items-center gap-2 px-3 py-3"
							onsubmit={(e) => {
								e.preventDefault();
								createWorkspace();
							}}
						>
							<input
								type="text"
								required
								placeholder={m.workspace_namePlaceholder()}
								bind:value={newWorkspaceName}
								maxlength={WORKSPACE_NAME_MAX}
								class={inputClass}
							/>
							<button type="submit" class={rowButtonClass} disabled={!!busy}>
								<RiAddLine class="size-3.5" />
								<span>{busy === "create" ? m.workspace_creating() : m.workspace_create()}</span>
							</button>
							{#if orgs && orgs.length > 0}
								<button
									type="button"
									class={rowButtonClass}
									onclick={() => (showCreateForm = false)}
								>
									{m.message_cancel()}
								</button>
							{/if}
						</form>
						{#if createError}
							<p class="border-t border-[var(--ap-border-1)] px-3 py-2 text-[length:var(--ap-text-2)]">
								{createError}
							</p>
						{/if}
					</div>
				{/if}
			</section>
		{/if}
	{/if}
</div>
