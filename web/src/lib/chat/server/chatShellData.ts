import { localeCookieName } from '$lib/i18n/locales';
import type { Cookies } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/chat/server/auth';
import { config } from '$lib/chat/server/config';
import { defaultModel } from '$lib/chat/server/models';
import { servingFor } from '$lib/chat/server/serving';
import { resolveTriggerStrategy } from '$lib/chat/search/triggerStrategy';
import { getTuning } from '$lib/chat/server/tuning';
import { ruleLabelCatalog } from '$lib/chat/server/ruleLabel';
import { offersShelf, preferredLanguage, shelf } from '$lib/chat/constants/starterShelf';
import { logger } from '$lib/chat/server/logger';
import { chromeLanguage } from '$lib/chat/chromeCopy';
import {
	STARTER_COUNT,
	STARTER_HISTORY_COOKIE,
	decodeStarterHistory,
	encodeStarterHistory,
	pickRotatingStarters
} from '$lib/chat/utils/starterRotation';
import {
	getLayoutConversationsForSidebar,
	getLayoutFeatureFlags,
	getLayoutModels,
	getLayoutPublicConfig,
	getLayoutStorageRegion,
	getLayoutSettings,
	getLayoutUser,
	normalizeLayoutSettings
} from '$lib/chat/server/layoutData';
import { maintenanceBanner as getMaintenanceBanner } from '$lib/website.server';
import { workspaceScopeFor } from '$lib/chat/server/currentWorkspace';
import { busyModels } from '$lib/chat/server/modelBusy';
import { SERVER_BUSY_REFRESH_MS } from '$lib/chat/routing/busyHere';
import { resolveBusyScope } from '$lib/chat/server/textGeneration/faultInjection';
import { countryFromHeader } from '$lib/chat/crisisLocale';

// The tuning panel (CUR-893) warns at save time when a starters override is too small to rotate.
export { STARTER_COUNT };

// routes/chat/+layout.server.ts's request always went through chat's own hook
// ($lib/chat/server/hooks/handle.ts, wired in hooks.server.ts) first, which already resolved
// event.locals.user/isAdmin/sessionId from the session cookie/header — that hook only runs for a
// /chat/* subpath. A Payload `chat` page reached via [...slug] (e.g. /alpha/chat, the landing page)
// is NOT a /chat/* subpath, so that hook never runs for it and locals
// arrives here completely unresolved: NavMenu.svelte's `page.data.user` read (which this function
// feeds) then always renders "Log in" — even for a genuinely authenticated visitor — and that
// link's own destination (/chat/login) redirects a truly-authenticated visitor straight back the
// moment they click it, since its load bounces anyone with `locals.user` already set.
//
// `locals.sessionId` is the signal: the hook ALWAYS sets it (minting a fresh one for a guest), so
// it being unset here means this request skipped the hook — resolve auth ourselves in that case,
// the same way the hook does, so the nav matches /chat/conversation/*'s signed-in state exactly. (CUR-1075)
export async function ensureChatLocalsResolved(
	locals: App.Locals,
	cookies: Cookies,
	request: Request | undefined
): Promise<void> {
	if (locals.sessionId || !request) return;
	const auth = await authenticateRequest(request.headers, cookies, new URL(request.url), false);
	locals.sessionId = auth.sessionId;
	locals.user = auth.user ?? undefined;
	locals.token = auth.token;
	locals.isAdmin = auth.isAdmin;
}

// Shared by routes/chat/+layout.server.ts (the dedicated /chat/* subtree — conversation, api,
// admin, ...) and [...slug]/+page.server.ts (the Payload `chat` page template) — both need the
// exact same shell data (settings/models/conversations/feature flags/copy) that ChatShell.svelte
// consumes, just reached via different routes. `request` is only needed by the latter — see
// ensureChatLocalsResolved above.
export async function loadChatShellData(
	locals: App.Locals,
	cookies: Cookies,
	fetch: typeof globalThis.fetch,
	request?: Request,
	routeId?: string | null
) {
	await ensureChatLocalsResolved(locals, cookies, request);

	const [
		tuning,
		publicConfig,
		featureFlags,
		models,
		settings,
		user,
		maintenanceBanner,
		workspaceScope,
		busyModelIds
	] = await Promise.all([
			getTuning(),
			getLayoutPublicConfig(),
			getLayoutFeatureFlags(locals),
			getLayoutModels(locals),
			getLayoutSettings(locals),
			Promise.resolve(getLayoutUser(locals)),
			getMaintenanceBanner(fetch),
			workspaceScopeFor(locals, request?.headers),
			readBusyModels(request)
		]);

	// Rotate 3 of the pool per visit instead of always showing the same ones, and don't
	// repeat the exact set a returning visitor just saw. The pool is whatever's live — an operator
	// override from the tuning panel if one is set, else the hardcoded default (suggestions.ts).
	// "Last shown" travels in a small first-party cookie (indices into the pool, never prompt text)
	// so this works for guests and signed-in visitors alike, with no server-side session needed. (CUR-620)
	const tuningStarters = tuning.starters;
	// The default pool is only the prompts with a passing live grade (starterShelf.ts). (CUR-1003)
	// Both pools are English, so a visitor who chose another interface language, or
	// whose browser asks for one first, gets no chips rather than English ones. (CUR-2323)
	const acceptLanguage = request?.headers.get('accept-language');
	const chosenLanguage = cookies.get(localeCookieName);
	const starterPool = !(chosenLanguage ? chosenLanguage === 'en' : offersShelf(acceptLanguage))
		? []
		: tuningStarters?.length
			? tuningStarters
			: shelf;
	const previousStarters = decodeStarterHistory(cookies.get(STARTER_HISTORY_COOKIE), starterPool);
	const shownStarters = pickRotatingStarters(starterPool, STARTER_COUNT, previousStarters);
	// This load also re-runs for a __data.json invalidation fetch (e.g. a shared
	// dependency like 'app:models' changing) after that request's response may already be
	// generating — SvelteKit throws "Cannot use cookies.set(...) after the response has been
	// generated" in that case, which would fail this ENTIRE shared load for every /chat/* page,
	// silently, at HTTP 200. The rotated starter set is cosmetic (which 3 example prompts a
	// visitor sees), never correctness-critical, so losing this one write is an acceptable
	// degradation — logged rather than swallowed, so a real spike is still visible.
	// An empty set (a non-English visitor, CUR-2323) keeps the last English set's history intact. (CUR-1251)
	if (shownStarters.length) {
		try {
			cookies.set(STARTER_HISTORY_COOKIE, encodeStarterHistory(shownStarters, starterPool), {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				maxAge: 60 * 60 * 24 * 90
			});
		} catch (err) {
			logger.warn({ err, routeId }, '[chatShellData] failed to set starter-history cookie, continuing without it');
		}
	}

	const defaultModelId = models[0]?.id ?? defaultModel?.id;

	return {
		// The live request log and the lines under an answer follow the language the
		// visitor chose for the interface, else the one their browser asks for first (chromeCopy.ts,
		// which also covers languages the main catalogs don't yet); model reply language stays separate. (CUR-1575 / CUR-2394)
		uiLang: chromeLanguage(cookies.get(localeCookieName) ?? preferredLanguage(acceptLanguage)),
		servingProvenance: servingFor(defaultModel, defaultModel?.id),
		// X-ray's "Stored in" hop. A region label only; the database URL stays on the server. (CUR-4580)
		storageRegion: getLayoutStorageRegion() ?? null,
		// The support card links findahelpline's page for this country. Read per request from
		// Vercel's geo header and never stored or logged; null off Vercel or when the header is missing. (CUR-3912)
		visitorCountry: countryFromHeader(request?.headers.get('x-vercel-ip-country')),
		safetyRules: ruleLabelCatalog(),
		// DO NOT DELETE AS UNUSED. No client component reads this today — the live search decision is
		// made server-side in runSearch.ts — but it is the surface scripts/verify-prod-config.mjs reads
		// off /chat/__data.json to assert which strategy production is actually serving, which is what
		// makes a deployment running a different strategy than the code describes (CUR-147) checkable from
		// outside it.
		searchTriggerStrategy: resolveTriggerStrategy(
			Reflect.get(config, 'PUBLIC_SEARCH_TRIGGER') as string | undefined
		),
		starters: shownStarters,
		publicConfig,
		...featureFlags,
		models,
		// Models whose turns keep ending on a 429 right now. Auto skips them; a hand pick stays. (CUR-4043)
		busyModels: busyModelIds,
		// How often an open tab re-reads those marks from /chat/api/busy (routing/busyHere.ts). (CUR-4629)
		busyRefreshMs: SERVER_BUSY_REFRESH_MS as number | null,
		user,
		// The account menu names the workspace new conversations count toward. (CUR-3014)
		currentWorkspace: workspaceScope?.current ?? null,
		// The account menu switches between these without a trip to Settings. (CUR-3097)
		workspaces: workspaceScope?.workspaces ?? [],
		// Invitations waiting on this person, listed in the account menu and Settings. (CUR-4167)
		pendingInvitations: workspaceScope?.invitations ?? [],
		// The menu lists former workspaces too, and names the one being looked at, so the
		// row never says Personal over another workspace's chats. (CUR-3040)
		formerWorkspaces: workspaceScope?.former ?? [],
		viewingFormer: workspaceScope?.viewingFormer ?? null,
		settings: normalizeLayoutSettings(settings),
		// The sidebar lists the current workspace's conversations only. (CUR-3023)
		conversations: getLayoutConversationsForSidebar(locals, 0, defaultModelId, workspaceScope),
		maintenanceBanner: {
			enabled: Boolean(maintenanceBanner.enabled) && Boolean(maintenanceBanner.message?.trim()),
			message: maintenanceBanner.message?.trim() ?? ''
		}
	};
}

/** The busy marks this page load routes around: the marks under a spec's scope (CUR-4042), behind the
 *  fault-inject gate, else everyone's. `/chat/api/busy` reads the same, so an open tab keeps it current. */
export async function readBusyModels(request: Request | undefined): Promise<string[]> {
	const scope = request ? await resolveBusyScope(request) : null;
	return busyModels(new Date(), scope ?? undefined);
}
