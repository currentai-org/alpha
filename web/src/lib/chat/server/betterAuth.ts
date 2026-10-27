/**
 * Better Auth server instance (CUR-434/CUR-432) — the identity/session source of truth for the new
 * sign-in surface: Google, GitHub, passkey, email-OTP (delivery via Resend, CUR-518), and Hugging Face
 * on `genericOAuth` so it gets the same native account-linking-by-verified-email as every
 * other provider, instead of a second hand-rolled merge path.
 *
 * This instance does NOT populate `event.locals` on its own — the bridge in server/auth.ts's
 * `authenticateRequest` resolves a Better Auth session first and shapes it into the existing
 * `{ user, sessionId, secretSessionId, isAdmin }` contract every other branch in that function returns,
 * so the rest of the app is unaffected by which auth system actually signed someone in.
 *
 * Option shapes follow the INSTALLED package's own source — `getAuthTables` in @better-auth/core,
 * and each plugin's own `.d.mts` — and vary across Better Auth versions. Re-check before bumping
 * the version.
 *
 * BUILT LAZILY (getAuth(), not a top-level `export const`), matching db/client.ts's own "lazy so
 * import-time has no side effects (serverless-friendly: no eager connect at module load)" contract.
 * Constructing the drizzle adapter calls getDb(), which THROWS synchronously if DATABASE_URL/
 * POSTGRES_URL is unset, so a bare top-level `export const auth = betterAuth({ database:
 * drizzleAdapter(getDb(), ...) })` would crash on import alone in any environment without a DB
 * configured: every cold serverless instance and any DB-less build/test run.
 */
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
// Per-plugin subpaths: the better-auth/plugins barrel loads every plugin (~2.6 s), and this
// file sits under every auth spec (CUR-2446).
import { emailOTP } from "better-auth/plugins/email-otp";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { organization } from "better-auth/plugins/organization";
import { oAuthProxy } from "better-auth/plugins/oauth-proxy";
import { admin } from "better-auth/plugins/admin";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { passkey } from "@better-auth/passkey";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
import { syncClientsPlugin } from "$lib/chat/server/sync/syncClients";
import { SYNC_ACCESS_TOKEN_PREFIX, SYNC_REFRESH_TOKEN_PREFIX } from "$lib/chat/server/sync/syncToken";
import { SYNC_CLIENTS, SYNC_SCOPE } from "../../../../config/thunderbolt";
import { getDb, schema } from "$lib/chat/server/db/client";
import { config } from "$lib/chat/server/config";
import { OIDConfig } from "$lib/chat/server/oidcConfig";
import { AUTH_BASE_PATH, CIMD_PATH, base } from "$lib/chat/paths";
import { captureServerException } from "$lib/chat/server/errorTracking";
import { logger, securityLogger } from "$lib/chat/server/logger";
import { hashIp } from "$lib/chat/server/db/ipHash";
import { hmacSha256, timingSafeEqual } from "$lib/chat/server/crypto";
import { getRequestEvent } from "$app/server";
import { dev } from "$app/environment";
import { deployEnv, isTestDeployment, type DeployEnv } from "$lib/chat/server/deployEnv";
import { mockOidcProvider } from "$lib/chat/server/mockOidc";
import { huggingFaceOAuthConfig, memoizeAuthUntilRejected } from "$lib/chat/server/authStartup";
import { authBaseURL, authOrigins } from "$lib/chat/server/authOrigins";
import { deploymentInstance, isEventInstance } from "$lib/chat/server/instance";
import { rememberActiveWorkspace, workspaceToResume } from "$lib/chat/server/resumeWorkspace";
import { refreshProviderEmail } from "$lib/chat/server/refreshProviderEmail";
import { stampDeletedWorkspace } from "$lib/chat/server/formerWorkspaces";
import { isReservedTestAddress, sendViaResend } from "$lib/chat/server/resend";
import { deviceIdForSignIn, newDeviceNoticeAccount, noticeNewDevice } from "$lib/chat/server/newDeviceNotice";
import { runInBackground } from "$lib/chat/server/vercelBackground";
import {
	JOIN_METHODS,
	CONFIG_CHANGE_RULES,
	RULES_VISIBILITIES,
	joinMethodRefusal,
	workspaceNameRefusal,
} from "$lib/chat/workspacePermissions";
import { defaultAc, adminAc, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { adminAc as staffAc, adminRoles as staffRoles } from "$lib/chat/server/adminRoles";
import {
	maxInvitesPerDay,
	recordWorkspaceInviteSend,
	workspaceInviteAllowed,
	siteInviteAllowed,
	recordSiteInviteSend,
} from "$lib/chat/server/db/workspaceInviteRate";
import { pendingInvitationCount } from "$lib/chat/server/pendingInvitations";
import {
	targetEmailSendAllowed,
	recordTargetEmailSend,
	otpSourceSendAllowed,
	recordOtpSourceSend,
} from "$lib/chat/server/db/targetEmailRate";
import {
	accountExistsForEmail,
	addressCodeAllowedToday,
	newAddressCodeAllowed,
	recordAddressCode,
	recordNewAddressCode,
} from "$lib/chat/server/db/signInCodeRate";
import { recordRateLimitTrip } from "$lib/chat/server/alerting";

function refuseJoinMethodWithoutAFlow(joinMethod: unknown) {
	const message = joinMethodRefusal(joinMethod);
	if (message) throw new APIError("BAD_REQUEST", { message });
}

// The name travels into the invitation email, so it is checked here and not only by the
// page's input, which any direct call to the API skips. (CUR-3194)
function refuseUnsendableWorkspaceName(name: unknown) {
	const message = workspaceNameRefusal(name);
	if (message) throw new APIError("BAD_REQUEST", { message });
}

// Unset in local dev (see .env.example) — Better Auth's own per-plugin defaults ("localhost" rpID, a
// matching origin) take over in that case, matching how this repo already treats PUBLIC_ORIGIN
// elsewhere (auth.ts's OIDC redirect URI construction has the same fallback shape).
const publicOrigin = config.PUBLIC_ORIGIN || undefined;

// baseURL must stay this ONE static value (CUR-1152/CUR-1162): it also seeds passkeyRpId and the
// cookie Domain below, and develop.aipotluck.org (a preview env with its OWN stable custom domain) is
// correctly served by it. Deriving baseURL from VERCEL_URL (the platform's auto-generated
// *.vercel.app hostname, unspoofable unlike a request's Host header) would break that domain, since
// VERCEL_URL is NEVER a custom domain, even on a deployment that has one aliased. No single baseURL
// value is correct for both "a deployment with its own domain" and "a deployment with only an
// auto-generated one", so the auto-generated hostname is ADDED as a second trusted origin below,
// alongside the static one baseURL already trusts implicitly.
//
// Only this team's preview hosts, never all of *.vercel.app. Any Vercel user can mint a
// *.vercel.app host, and oAuthProxy hands the encrypted sign-in payload to whatever callback passes this
// list. Vercel names a deployment `aipotluck-<9 chars>-current-ai.vercel.app` and a branch alias
// `aipotluck-git-<branch>-current-ai.vercel.app`; better-auth's `?` matches one character and `*` any
// run. Someone could still claim a Vercel project named in one of these shapes, which only a check
// against Vercel's own API would rule out. (CUR-3521)
const PREVIEW_TRUSTED_ORIGINS = [
	"https://aipotluck-?????????-current-ai.vercel.app",
	"https://aipotluck-git-*-current-ai.vercel.app",
];
export function computePreviewTrustedOrigins(env: DeployEnv | null): string[] | undefined {
	return env === "preview" ? PREVIEW_TRUSTED_ORIGINS : undefined;
}
const previewTrustedOrigins = computePreviewTrustedOrigins(deployEnv());

// Passkey RP ID is domain-bound by the WebAuthn spec — a credential registered under one origin will
// not authenticate under another (preview URL vs prod, or a scheme/port change). Deriving both from the
// SAME PUBLIC_ORIGIN this app already treats as canonical keeps that one variable as the single source
// of truth rather than hand-tuning two. Known limitation, not a blocker: a passkey registered on a
// preview deploy won't carry to prod, or to a different preview URL next time.
//
// Pinned to the apex when PUBLIC_ORIGIN's hostname is the apex or one of its subdomains — a
// credential (or session cookie, below) scoped to the exact hostname today would not carry to a
// sibling subdomain after a chat.aipotluck.org/alpha.aipotluck.org split, and a WebAuthn credential
// already registered narrow can't be widened after the fact. Per spec, any subdomain of an RP ID's
// registrable domain is a valid origin for that credential, so pinning to the apex covers every
// subdomain permanently, including the split that hasn't happened yet. Guarded rather than
// unconditional: a preview deploy's real hostname is a *.vercel.app domain, not a subdomain of the
// apex, and the browser rejects an RP ID that isn't a registrable-domain suffix of the actual origin —
// pinning those to "aipotluck.org" would break passkeys there outright, not just leave them narrow. (CUR-697)
export const APEX_DOMAIN = "aipotluck.org";

/** True when `hostname` is the apex or one of its subdomains. Pure, exported for testing (CUR-697) —
 * the check that decides whether it's safe to pin the RP ID / cookie Domain to the apex rather than
 * the exact serving hostname. */
export function isApexOrSubdomain(hostname: string | undefined): boolean {
	return hostname === APEX_DOMAIN || (hostname?.endsWith(`.${APEX_DOMAIN}`) ?? false);
}

// Not isApexOrSubdomain(PUBLIC_ORIGIN's hostname): PUBLIC_ORIGIN is the same Doppler `preview` value
// synced identically to every preview deployment, ephemeral or not (no per-branch scoping in Vercel),
// so it would read true on every preview build, including an ephemeral per-PR one whose real serving
// host is a *.vercel.app domain, the case the guard above exists for. Better Auth's session cookie
// would then ship Domain=aipotluck.org from a *.vercel.app response, Chromium discards it on receipt,
// and a signed-in visitor loses their session on the next navigation with nothing logged (CUR-1172).
//
// VERCEL_GIT_COMMIT_REF is per-deployment (the actual branch being built), unlike PUBLIC_ORIGIN — only
// develop's own deployments get "develop" here, the one preview branch with a real aipotluck.org
// subdomain aliased to it. VERCEL_URL alone is not enough (CUR-1152): it's develop's own
// auto-generated *.vercel.app hostname too, not its aliased custom domain.
//
// Pure and exported (CUR-1172) for the same reason isApexOrSubdomain above is — a module-level const
// computed once from process.env can't be exercised by a test without reimporting the whole module.
export function computeOriginIsApexOrSubdomain(env: {
	VERCEL_ENV?: string;
	VERCEL_GIT_COMMIT_REF?: string;
}): boolean {
	return env.VERCEL_ENV === "production" || env.VERCEL_GIT_COMMIT_REF === "develop";
}

// The session cookie's name and scope, per deployment. Every deployment's cookie is host-only (no
// Domain attribute), so it goes back only to the host that set it.
//
// production's cookies are `__Host-aip.*`. A browser sends a host-only cookie to no other
// aipotluck.org host, so develop, the status page and the other third-party subdomains never see a
// production session. The `__Host-` prefix also makes the browser refuse a same-name cookie that a
// subdomain tries to plant with Domain=aipotluck.org. It requires Secure, Path=/ and no Domain. Better
// Auth only knows the `__Secure-` prefix, so production turns that off and sets Secure itself. The old
// apex cookies are expired by `expireLegacySessionCookies` (hooks.server.ts).
// (CUR-4442)
// Develop and previews keep a name of their own as well, so a sign-in on one never
// overwrites another's cookie. (CUR-1904)
export const PRODUCTION_COOKIE_PREFIX = "__Host-aip";
const PREVIEW_COOKIE_PREFIX = "aip-preview";
//
// An event instance (mozfest, lugano) is a second production deployment with its own
// database, so it gets `aip-<instance>`, checked before the production branch. (CUR-3156)
export function computeSessionCookieScope(env: {
	VERCEL_ENV?: string;
	VERCEL_GIT_COMMIT_REF?: string;
	INSTANCE?: string;
}): {
	cookiePrefix: string;
	useSecureCookies?: false;
	defaultCookieAttributes?: { secure: true };
} {
	if (isEventInstance(env)) return { cookiePrefix: `aip-${deploymentInstance(env)}` };
	if (env.VERCEL_ENV === "production") {
		return { cookiePrefix: PRODUCTION_COOKIE_PREFIX, useSecureCookies: false, defaultCookieAttributes: { secure: true } };
	}
	return { cookiePrefix: PREVIEW_COOKIE_PREFIX };
}
const sessionCookieScope = computeSessionCookieScope(process.env);
// The passkey RP ID and its trusted origins, per deployment. On a per-PR preview the browser
// is on the deployment's own *.vercel.app host (VERCEL_URL, the URL the scenario suite resolves), and
// PUBLIC_ORIGIN is develop's shared value, so an RP ID taken from PUBLIC_ORIGIN names a host the
// browser isn't on and every registration is refused. vercel.app is a public suffix, so the RP ID has
// to be that exact hostname. A passkey made there works on that deployment only, which is all a
// throwaway preview needs.
// (CUR-1708)
// An event instance registers against its own host, checked before the apex branch. Its
// database holds none of www's passkeys, so an apex RP ID would offer the browser credentials it
// can't verify. (CUR-3156)
export function computePasskeyRp(
	env: { VERCEL_ENV?: string; VERCEL_GIT_COMMIT_REF?: string; VERCEL_URL?: string; INSTANCE?: string },
	publicOrigin: string | undefined
): { rpID: string | undefined; origins: string[] | undefined } {
	if (!publicOrigin) return { rpID: undefined, origins: undefined };
	const origins = authOrigins(publicOrigin, env);
	if (isEventInstance(env)) return { rpID: new URL(publicOrigin).hostname, origins };
	if (computeOriginIsApexOrSubdomain(env)) return { rpID: APEX_DOMAIN, origins };
	if (env.VERCEL_ENV === "preview" && env.VERCEL_URL) {
		return { rpID: env.VERCEL_URL, origins: [...origins, `https://${env.VERCEL_URL}`] };
	}
	return { rpID: new URL(publicOrigin).hostname, origins };
}
// Unset in local dev, like publicOrigin, so the plugin falls back to its own defaults.
const { rpID: passkeyRpId, origins: passkeyOrigins } = computePasskeyRp(process.env, publicOrigin);

// Google and GitHub sign-in on a PR preview's own *.vercel.app host. Every preview sends
// develop's redirect_uri (baseURL comes from PUBLIC_ORIGIN), so the provider calls back to develop,
// which holds no state cookie for a sign-in started elsewhere. oAuthProxy carries the state through
// develop encrypted and hands the profile back to the preview's /oauth-proxy-callback, which must be a
// trusted origin (`computePreviewTrustedOrigins` above). On develop itself the plugin skips proxying, because
// the current origin is productionURL's, and a callback whose state doesn't decrypt falls through to
// the normal handler.
//
// It proxies `/sign-in/social` only, so Hugging Face (genericOAuth) stays develop-only. Passkeys are
// untouched: a PR preview already registers against its own host (computePasskeyRp, CUR-1708).
// The proxy secret defaults to BETTER_AUTH_SECRET, which develop and every PR preview already share
// through the `preview` Doppler config along with develop's database, so it grants a preview nothing
// it doesn't hold today. Production never registers it. (CUR-3096)
export function computeOAuthProxyProductionURL(
	env: DeployEnv | null,
	publicOrigin: string | undefined
): string | undefined {
	return env === "preview" && publicOrigin ? publicOrigin : undefined;
}
const oAuthProxyProductionURL = computeOAuthProxyProductionURL(deployEnv(), publicOrigin);

// OIDConfig.CLIENT_ID='__CIMD__' is a sentinel, not a real client id — genericOAuth below sends
// whatever's in `clientId` to the provider verbatim (no v6-`discovery()`-style resolution the way
// auth.ts's getOIDCClient has), so passing the sentinel straight through 400s at HF as
// "Invalid client_id". Resolve it the same way auth.ts does: the real
// client_id under CIMD is the URL of this app's own metadata document
// (routes/chat/.well-known/oauth-cimd/+server.ts), built from the same PUBLIC_ORIGIN this file
// already treats as canonical for passkeyRpId above.
const hfClientId =
	OIDConfig.CLIENT_ID === "__CIMD__" && publicOrigin
		? new URL(CIMD_PATH, publicOrigin).toString()
		: OIDConfig.CLIENT_ID;

// The stand-in OIDC provider for the sign-in e2e spec. See mockOidc.ts for why it never
// replaces Hugging Face, never registers on production or at a public address, and cannot take the
// other providers down. (CUR-1551)
const mockOidc = mockOidcProvider({
	deployEnv: deployEnv(),
	url: config.MOCK_OIDC_PROVIDER_URL,
	clientId: config.MOCK_OIDC_CLIENT_ID,
	clientSecret: config.MOCK_OIDC_CLIENT_SECRET,
});
if (!mockOidc.register && mockOidc.reason === "production") {
	logger.error(
		"[auth] MOCK_OIDC_* is set on production — the mock sign-in provider is refused here; delete those vars from prd"
	);
}
if (!mockOidc.register && mockOidc.reason === "not-loopback") {
	logger.warn(
		{ url: config.MOCK_OIDC_PROVIDER_URL },
		"[auth] MOCK_OIDC_PROVIDER_URL is not a loopback address — the mock sign-in provider registers only beside the test run (CUR-2451), so it is off here"
	);
}

// Defense-in-depth against email bombing: Better Auth's own rate limiter is keyed on (ip, path), not
// the target email (createRateLimitKey, api/rate-limiter/index.mjs) — so from many IPs there's no cap
// at all on how many real emails land on one arbitrary address, existing user or not. This is a
// second, email-keyed limiter. Same "best-effort, in-memory, per-instance" character as Better Auth's
// own default (no secondaryStorage is configured here either) — not a distributed guarantee, just a
// real backstop where none existed for this dimension.
//
// Two independent instances (OTP sends, workspace invitations, CUR-550) rather than one shared map —
// a flood of sign-in codes to an address shouldn't also block a legitimate workspace invite to it, or
// vice versa. Each is still keyed on the target email, not the caller, matching the threat this guards
// against (an app-controlled sender spamming one arbitrary inbox).
function createTargetEmailRateLimiter(windowMs: number, max: number) {
	const recentSendsByEmail = new Map<string, number[]>();
	return function tooManyRecentSends(email: string): boolean {
		const now = Date.now();
		const key = email.toLowerCase();
		const recent = (recentSendsByEmail.get(key) ?? []).filter((t) => now - t < windowMs);
		if (recent.length >= max) {
			recentSendsByEmail.set(key, recent);
			return true;
		}
		recent.push(now);
		recentSendsByEmail.set(key, recent);
		return false;
	};
}

// Better Auth's built-in "admin" role only grants `organization: ["update"]`; "delete" is owner-only
// by default (plugins/organization/access/statement.mjs, adminAc vs ownerAc). This app's workspace
// admin IS Better Auth's "admin" role (creatorRole below), and "owner" is never assigned (the app has
// two roles, admin and member), so without this an app admin calling the plugin's own
// /organization/delete gets a 403 (YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_ORGANIZATION) from the installed
// hasPermission check (CUR-827). This extends rather than replaces the built-in admin role (spreads
// adminAc.statements) so every existing admin ability (invite, remove, cancel) is unaffected; only
// `organization` widens to add "delete".
// A plain module-level object (not built inside buildAuth()) so it's importable by a test with no live
// DB — same lazy-init discipline as sendVerificationOTP/sendWorkspaceInvitationEmail above — and because
// it's the SAME object reference passed into the organization() plugin config below, importing it proves
// the wiring, not just the role definition.
export const ORG_ROLES = {
	admin: defaultAc.newRole({ ...adminAc.statements, organization: ["update", "delete"] }),
	member: memberAc,
	owner: ownerAc,
};

// Deliberately loose (10 min / 3 sends) since it's a backstop, not the primary control, and a
// legitimate user rarely needs more retries than that inside one 5-minute-expiry code's lifetime.
// Named so the CUR-920 DB-backed backstop (targetEmailRate.ts) shares the exact same thresholds
// rather than duplicating the literals in a second place.
const OTP_RATE_WINDOW_MS = 10 * 60 * 1000;
// Exported so a test can assert OTP_SOURCE_MAX (targetEmailRate.ts) stays strictly below this — the
// two constants live in different modules and are linked only by a comment on each side otherwise,
// which can drift silently.
export const OTP_RATE_MAX = 3;
const tooManyRecentOTPSends = createTargetEmailRateLimiter(OTP_RATE_WINDOW_MS, OTP_RATE_MAX);

// Better Auth's emailOTP plugin never hands sendVerificationOTP a request object of its own (it's
// declared as a plain (data) => Promise<void> in the plugin's own types) — getRequestEvent() is the
// SAME ambient-access pattern already used for sveltekitCookies(getRequestEvent) above, reading the
// SvelteKit RequestEvent that's active for the whole call chain in a real deploy. Wrapped because a
// direct unit-test call to sendVerificationOTP (no live request) throws here — falling back to null
// is the correct behavior anyway: otpSourceSendAllowed/recordOtpSourceSend both already treat a
// missing IP as "can't track this dimension," same fail-open posture as every other cap in this file.
//
// Logged once (not swallowed silently): a real unit test hitting this path is
// expected and not worth logging every time, but if this ever throws in a live deploy it means the
// source-pair cap has gone dark with nothing showing up anywhere — same "warn once" shape as
// ipHash.ts's warnedNoPepper.
let warnedNoRequestContext = false;
function currentClientAddress(): string | null {
	try {
		return getRequestEvent().getClientAddress();
	} catch (e) {
		if (!warnedNoRequestContext) {
			logger.warn(
				e,
				"[auth] currentClientAddress() failed — email-OTP source-pair cap disabled for this call"
			);
			warnedNoRequestContext = true;
		}
		return null;
	}
}
// Looser (10 min / 10 sends) — an admin legitimately inviting a whole team lands several DIFFERENT
// target emails inside one window, so this only bites a resend flood against the SAME address.
const INVITE_RATE_WINDOW_MS = 10 * 60 * 1000;
const INVITE_RATE_MAX = 10;
const tooManyRecentInvitationSends = createTargetEmailRateLimiter(INVITE_RATE_WINDOW_MS, INVITE_RATE_MAX);

/**
 * Real Resend delivery when RESEND_API_KEY is set (Preview/Production, CUR-518);
 * otherwise a log-only stub (local dev, or if the key is unset elsewhere) — same
 * "unset → gracefully absent" shape as GOOGLE_CLIENT_ID/GITHUB_CLIENT_ID above. Extracted to a
 * standalone export (not an inline closure in buildAuth()) so it's unit-testable without a live
 * betterAuth() instance — buildAuth() eagerly calls getDb(), which throws without DATABASE_URL — the
 * same move betterAuth.accountMerge.spec.ts already makes for handleOAuthUserInfo.
 *
 * Better Auth's own email-otp route always returns {success:true} to the client no matter what
 * happens here (runInBackgroundOrAwait, in the installed package, unconditionally swallows any
 * exception and never inspects the result) — and that's deliberate on their part, not a bug: a
 * response that let a caller distinguish "email doesn't exist" from "send failed" from "sent fine"
 * would leak account existence and mail-provider health to an unauthenticated caller. So a Resend
 * failure is logged here, not thrown at the surface — this app's own logger (reaching Axiom) is the
 * place a send failure or bad key becomes visible.
 *
 * Past `tooManyRecentSends`, still gated on RESEND_API_KEY: signup-via-email stays on (this is a
 * genuine onboarding path — passkey can't bootstrap a new user cold, and OAuth-only would leave
 * "no single company is the only way in" untrue) but capped per target address, not just per IP.
 */
export async function sendVerificationOTP({
	email,
	otp,
	type,
}: {
	email: string;
	otp: string;
	type: "sign-in" | "email-verification" | "forget-password" | "change-email";
}) {
	if (!config.RESEND_API_KEY) {
		if (dev) {
			// Local dev only: the code has to be readable somewhere or nobody can sign in. In any deploy
			// this branch is a misconfiguration, and a sign-in code must never land in a shipped log line.
			logger.info({ email, otp, type }, "[auth] email-OTP stub — RESEND_API_KEY unset (dev)");
		} else {
			logger.error(
				{ type },
				"[auth] RESEND_API_KEY unset — email-OTP not sent and not logged; sign-in by email is down"
			);
			void captureServerException(new Error("RESEND_API_KEY unset — email-OTP not sent"));
		}
		return;
	}

	// e2e scenario suites mint disposable `e2e-<uuid>@example.org` addresses and read the OTP
	// straight from the database, never opening a mailbox — every real Resend send to that domain is
	// undeliverable and unread, yet still counted against Resend's daily cap. `example.org` is IANA-
	// reserved for documentation (RFC 2606) and publishes a null MX record (RFC 7505) declaring it
	// accepts no mail at all, so no real person can ever hold an address there — the blunt suffix match
	// below cannot misfire on a user. Checked ahead of the rate-limit reads/writes below too, since
	// there's nothing worth tracking for a domain that will never receive mail either way. What this
	// deliberately gives up: the suite no longer exercises the real Resend call for these addresses, a call
	// into a void that only proved "we called Resend," never "mail arrives." Real delivery coverage needs
	// one deliberate test against a domain that can actually receive mail, not one on every e2e run. (CUR-1254)
	if (isReservedTestAddress(email)) {
		logger.info({ type, domain: "example.org" }, "[auth] email-OTP suppressed — reserved test domain");
		return;
	}

	// This (ip, target) pair check MUST run, and be fully resolved, before either target-wide check below
	// records anything — the whole point is that a single source can contribute at most OTP_SOURCE_MAX
	// toward a victim's target-wide OTP_RATE_MAX budget. Running it after the target-wide DB record would
	// let a pair-blocked 3rd attempt from the SAME source still consume the victim's final target-wide
	// slot, exhausting the whole budget from one source in exactly the number of requests this check
	// exists to prevent. Checked here, before the source has spent anything against the target-wide
	// counters; both records fire together at the bottom, only once every check passes.
	const clientAddress = currentClientAddress();
	if (!(await otpSourceSendAllowed(clientAddress, email))) {
		securityLogger.info(
			{ type, ipHash: hashIp(clientAddress, "rate-limit") },
			"[auth] email-OTP rate-limited by (source, target) pair — skipping Resend send"
		);
		return;
	}

	if (tooManyRecentOTPSends(email)) {
		securityLogger.info({ type }, "[auth] email-OTP rate-limited by target address — skipping Resend send");
		return;
	}

	// DB-backed backstop for the in-memory check above — see targetEmailRate.ts for why the
	// in-memory Map alone is bypassable across Vercel's per-instance serverless model. (CUR-920)
	if (!(await targetEmailSendAllowed(email, "otp", OTP_RATE_WINDOW_MS, OTP_RATE_MAX))) {
		securityLogger.info(
			{ type },
			"[auth] email-OTP rate-limited by target address (DB-backed) — skipping Resend send"
		);
		return;
	}
	// The caps above are per address, so a script rotating addresses passes them all. Both daily
	// caps below apply only to addresses with no account. Spending either stops a new sign-up for the day,
	// never an existing account's sign-in, which keeps only the 10-minute caps above: a daily cap on a
	// member's own address would let anyone who knows it lock them out for 24 hours. (CUR-4172)
	const isNewAddress = !(await accountExistsForEmail(email));
	if (isNewAddress && !(await addressCodeAllowedToday(email))) {
		securityLogger.info({ type }, "[auth] email-OTP over the per-address daily cap — skipping Resend send");
		return;
	}
	if (isNewAddress && !(await newAddressCodeAllowed())) {
		securityLogger.warn({ type }, "[auth] site-wide ceiling on sign-in codes to new addresses reached (CUR-4172)");
		void recordRateLimitTrip("otp-site-new-ceiling", {
			limitName: "the daily ceiling on sign-in codes to new addresses",
			identity: "signed-out requests across many addresses",
		});
		return;
	}
	void recordTargetEmailSend(email, "otp", OTP_RATE_WINDOW_MS);
	void recordOtpSourceSend(clientAddress, email, OTP_RATE_WINDOW_MS);
	if (isNewAddress) {
		void recordAddressCode(email);
		void recordNewAddressCode();
	}

	const sent = await sendViaResend({
		to: email,
		// Code stays in the body only, not the subject — considered putting it in the subject too
		// (skips opening the email) but decided against it: the subject line is visible in
		// lock-screen/notification previews and mail-server logs, and that exposure isn't worth the
		// one extra tap it saves.
		subject: "Your Alpha sign-in code",
		text: `Your sign-in code is ${otp}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
	});

	if (!sent.ok) {
		logger.error({ type, status: sent.status, body: sent.body }, "[auth] Resend send failed");
		void captureServerException(new Error(`Resend send failed: ${sent.status}`));
		return;
	}

	logger.info({ type, resendId: sent.id }, "[auth] email-OTP sent via Resend");
}

/**
 * Real Resend delivery for a workspace invitation — wired as the organization plugin's own
 * `sendInvitationEmail` hook below. Same shape as sendVerificationOTP (dev-log stub when
 * RESEND_API_KEY is unset, failure logged not thrown, per-target-email rate cap): Better Auth's own
 * invite-member route calls this via `runInBackgroundOrAwait`, which swallows whatever it throws, so a
 * Resend failure only becomes visible through this file's own logger.
 *
 * `origin` is resolved by the caller (buildAuth's plugin config) from the same PUBLIC_ORIGIN-or-
 * request.url fallback auth.ts already uses for its own redirect URIs, not duplicated here. (CUR-550)
 */
export async function sendWorkspaceInvitationEmail({
	id,
	email,
	organizationName,
	inviterEmail,
	acceptUrl,
}: {
	id: string;
	email: string;
	organizationName: string;
	inviterEmail: string;
	acceptUrl: string;
}) {
	if (!config.RESEND_API_KEY) {
		if (dev) {
			logger.info(
				{ email, id, acceptUrl },
				"[auth] workspace-invite email stub — RESEND_API_KEY unset (dev)"
			);
		} else {
			logger.error(
				{},
				"[auth] RESEND_API_KEY unset — workspace-invite email not sent and not logged"
			);
			void captureServerException(new Error("RESEND_API_KEY unset — workspace-invite email not sent"));
		}
		return;
	}

	// workspaces.spec.ts invites a fresh `@example.org` address on every run and checks the
	// Pending row, never the mailbox. Checked before the rate limiters, as in sendVerificationOTP. (CUR-1930)
	if (isReservedTestAddress(email)) {
		logger.info({ domain: "example.org" }, "[auth] workspace-invite suppressed — reserved test domain");
		return;
	}

	if (tooManyRecentInvitationSends(email)) {
		securityLogger.info({}, "[auth] workspace-invite rate-limited by target address — skipping Resend send");
		return;
	}

	// DB-backed backstop for the in-memory check above — see targetEmailRate.ts. (CUR-920)
	if (!(await targetEmailSendAllowed(email, "invite", INVITE_RATE_WINDOW_MS, INVITE_RATE_MAX))) {
		logger.info(
			{},
			"[auth] workspace-invite rate-limited by target address (DB-backed) — skipping Resend send"
		);
		return;
	}
	void recordTargetEmailSend(email, "invite", INVITE_RATE_WINDOW_MS);

	const sent = await sendViaResend({
		to: email,
		// The subject is fixed text and the body names who sent it, so the part a stranger
		// controls (the workspace name, already refused if it holds a link) never leads the email. (CUR-3194)
		subject: "You've been invited to a workspace on Alpha",
		text: `${inviterEmail} invited you to join the workspace "${organizationName}" on Alpha. Accept the invitation: ${acceptUrl}\n\nIf you don't know ${inviterEmail}, you can ignore this email.`,
	});

	if (!sent.ok) {
		logger.error({ status: sent.status, body: sent.body }, "[auth] Resend send failed (workspace invite)");
		void captureServerException(new Error(`Resend send failed (workspace invite): ${sent.status}`));
		return;
	}

	logger.info({ resendId: sent.id, invitationId: id }, "[auth] workspace-invite email sent via Resend");
}

/**
 * The invitation caps, checked before the invitation row exists. Counted in the
 * send path, a capped invite left a Pending row nobody would ever receive. The per-inviter cap
 * (CUR-912) goes first so one account's refusal never spends a site-wide slot. The site-wide ceiling
 * guards Resend's quota and real inboxes, so an invite to the reserved test domain, which never
 * reaches Resend (CUR-1930), doesn't count against it.
 * (CUR-2835 / CUR-3194)
 * An invite also shows in the invitee's account menu, with no mail sent, so the number one
 * address can be holding is capped for every address, the reserved test domain included. Fails open
 * on a read error, like the caps above. (CUR-4167)
 */
const MAX_PENDING_INVITES_PER_ADDRESS = 5;

export async function refuseOverInviteCaps(
	inviter: { id: string; createdAt?: Date | string | null },
	email: string
) {
	const inviterId = inviter.id;
	if (!(await workspaceInviteAllowed(inviterId, inviter.createdAt))) {
		throw new APIError("TOO_MANY_REQUESTS", {
			message: `You've sent ${maxInvitesPerDay(inviter.createdAt)} invitations a day, the daily limit. Try again tomorrow.`,
		});
	}
	const pending = await pendingInvitationCount(email);
	if (pending !== null && pending >= MAX_PENDING_INVITES_PER_ADDRESS) {
		throw new APIError("TOO_MANY_REQUESTS", {
			message: "That address can't take more workspace invitations until it answers the ones it has.",
		});
	}
	const sendsMail = !isReservedTestAddress(email);
	if (sendsMail && !(await siteInviteAllowed())) {
		securityLogger.warn({}, "[auth] site-wide workspace-invite ceiling reached (CUR-3194)");
		void captureServerException(new Error("Site-wide workspace-invite ceiling reached (CUR-3194)"));
		throw new APIError("TOO_MANY_REQUESTS", {
			message: "Alpha has sent as many workspace invitations as it can today. Try again tomorrow.",
		});
	}
	await recordWorkspaceInviteSend(inviterId);
	if (sendsMail) await recordSiteInviteSend();
}

// The email-OTP plugin's own built-in per-(ip,path) rate limit (3/60s independently on
// EACH of several paths, node_modules/better-auth/dist/plugins/email-otp/index.mjs) makes the e2e
// scenario suite sleep ahead of a refusal it deliberately never wants to trip — see
// e2e/scenarios/helpers/signIn.ts's own otpRateLimitState comment. Better Auth's top-level
// rateLimit.customRules exposes a per-request function that can return `false` to skip the limit
// entirely for one call (node_modules/better-auth/dist/api/rate-limiter/index.mjs:259-276), keyed by
// exact path — used here rather than the plugin's OWN `rateLimit` option because that option sets a
// single static {window,max} uniformly across every path the plugin defines it for, so touching it
// would also loosen check-verification-otp, the actual brute-force guard on the code itself.
//
// Two paths carry this carve-out, both wired to the SAME function below because both share the
// request body's `email` field: `/email-otp/send-verification-otp` (the send) and `/sign-in/email-otp`
// (this app's real verify call — +page.svelte's verifyOtp() calls authClient.signIn.emailOtp(),
// which resolves to this path, NOT `/email-otp/check-verification-otp`; it has its own independent
// 3/60s bucket, a different (ip, path) key from the send, so carving out only the send still leaves the
// suite's verify rejected with "Too many requests"). `/email-otp/check-verification-otp` itself stays
// untouched — this app never calls it, so carving it out would only be exposure with no suite benefit.
//
// Three conditions, ALL required, so this can only ever narrow what one specific request skips — it
// never widens the cap for a real user, on either path:
//   1. deployEnv() must be explicitly "preview" or "development" — an allow-list, not `!== "production"`,
//      so a misconfigured/undeclared environment (deployEnv() returning null) fails closed rather than
//      being treated as "not production". Reads deployEnv(), not raw VERCEL_ENV: reading the host var
//      directly is the mistake this module exists to prevent (CUR-208).
//   2. a secret header matching E2E_OTP_BYPASS_TOKEN, set ONLY in Doppler's preview/dev configs, never
//      prd — so even a defect in condition 1 can't fire in production, because the value the header
//      would need to match doesn't exist there. Compared as fixed-width HMAC digests, the CUR-922
//      pattern (safety/screen/+server.ts, hooks/handle.ts) — never a raw string `===`.
//   3. the request's target email ends with @example.org — the one domain sendVerificationOTP above
//      already proves inert: it suppresses both the real send AND the app's own (ip,target)/
//      target-wide OTP_RATE_MAX budget for it, before either ever runs (CUR-1254). Stacking this means a leaked
//      header secret is bounded to hammering an endpoint that can only ever no-op — not "bypass the
//      send cap for any target on any preview," which conditions 1+2 alone would allow.
// Any condition failing echoes currentRule back unchanged (the customRules type signature is
// `false | Rule`, no `undefined` — echoing the rule Better Auth already resolved is the typed
// equivalent of "apply the real limit", never widening it). (CUR-1553)
const OTP_BYPASS_HASH_LABEL = "otp-send-cap-carveout-v1";

export async function otpSendCapCarveOut(
	req: Request,
	currentRule: { window: number; max: number }
): Promise<false | { window: number; max: number }> {
	if (!isTestDeployment()) return currentRule;

	const bypassSecret = config.E2E_OTP_BYPASS_TOKEN;
	if (!bypassSecret) return currentRule;
	const [supplied, expected] = await Promise.all([
		hmacSha256(OTP_BYPASS_HASH_LABEL, req.headers.get("x-e2e-otp-bypass") ?? ""),
		hmacSha256(OTP_BYPASS_HASH_LABEL, bypassSecret),
	]);
	if (!timingSafeEqual(supplied, expected)) return currentRule;

	// req.clone() so this doesn't consume the body the real route handler still needs to read.
	const parsed = (await req
		.clone()
		.json()
		.catch(() => null)) as { email?: unknown } | null;
	if (typeof parsed?.email !== "string" || !parsed.email.toLowerCase().endsWith("@example.org")) {
		return currentRule;
	}

	return false;
}

// Better Auth keys its sign-in caps on (client IP, path), 3 per 10 s for /sign-in/* and 3 per
// 60 s for the email-code send, so everyone behind one venue or conference NAT address shares them
// and the fourth visitor is told "Too many requests". The multiplier raises the per-IP max for the
// sign-in family only and keeps each window. The real guards stay: the per-address and per-source
// OTP send caps (CUR-920, CUR-4172), and the per-code attempt limit. check-verification-otp is not
// listed, so it keeps the built-in cap. (CUR-4594)
export const SIGN_IN_SHARED_IP_MULTIPLIER = 20;

export async function venueSignInRule(
	req: Request,
	currentRule: { window: number; max: number }
): Promise<false | { window: number; max: number }> {
	const carved = await otpSendCapCarveOut(req, currentRule);
	if (carved === false) return false;
	return { window: carved.window, max: carved.max * SIGN_IN_SHARED_IP_MULTIPLIER };
}

// Kept as a plain function (not inlined into getAuth) so `ReturnType<typeof buildAuth>` below infers
// the CONCRETE options type TypeScript resolved from this literal — `ReturnType<typeof betterAuth>`
// directly would widen to the generic `Auth<BetterAuthOptions>`, which the specific instance built here
// (with its own literal plugins/database/etc. types) isn't assignable to.
function buildAuth() {
	return betterAuth({
			database: drizzleAdapter(getDb(), { provider: "pg", schema, usePlural: false }),
			secret: config.BETTER_AUTH_SECRET,
			// Production answers on www. and chat. per request; everywhere else this is still
			// the static PUBLIC_ORIGIN. See authOrigins.ts. (CUR-1067)
			baseURL: authBaseURL(publicOrigin, process.env),
			// Pinned on every surface (CUR-4448): every OAuth callback registered with Google, GitHub and
			// Hugging Face, and the Thunderbolt issuer, carry this path. A reserved path (paths.ts).
			basePath: AUTH_BASE_PATH,
			// Additive-only: no window/max here, so production's built-in 3/60s default on every email-otp path
			// (including the two named below) is unchanged. customRules can only skip the limit for a path key it
			// matches, and only when otpSendCapCarveOut's three conditions all hold (see its own comment above);
			// same function for both, since both requests carry the same `email` body field the function reads
			// (CUR-1553).
			// findVerificationValue purges all lapsed verification rows on every call (better-auth
			// db/internal-adapter.mjs). Once anyone else signs in, a person's lapsed code has been purged before
			// they type it; the verify then finds nothing and answers "Invalid OTP", shown as "That code doesn't
			// match" in place of the copy for a lapsed code (CUR-2793). The daily cron sweeps lapsed rows instead
			// (db/cleanup.ts, CUR-939), and a code its own verify finds lapsed is still deleted then.
			verification: { disableCleanup: true },
			rateLimit: {
				customRules: {
					"/email-otp/send-verification-otp": venueSignInRule,
					"/sign-in/email-otp": venueSignInRule,
					"/sign-in/*": venueSignInRule,
				},
			},
			// Without this, baseURL's own origin is the ONLY trusted origin (checked against the
			// installed source: origin-check.mjs's validateOrigin matches the request's Origin/Referer
			// header against context.trustedOrigins, which defaults to just [baseURL]) — so an ephemeral
			// PR-preview deploy, whose real hostname is never baseURL's static value, fails this check on
			// every request. The wildcard is scoped to Vercel's own domain, not attacker-controlled: an
			// Origin header reflects the REQUESTING PAGE's real origin (browser-enforced on fetch/XHR, not
			// spoofable by page script the way a Host header is), so this only ever matches a page actually
			// served from one of this team's preview deployments (CUR-3521). (CUR-1162)
			trustedOrigins: previewTrustedOrigins,
			// CUR-697 pinned production's session cookie to the apex; CUR-1904 gives every other deployment
			// its own cookie name, host-only. See computeSessionCookieScope above.
			advanced: sessionCookieScope,
			// disableImplicitLinking, not an empty trustedProviders list, is the switch for "no silent
			// cross-provider merge" (CUR-850; betterAuth.accountMerge.spec.ts). In the installed source
			// (oauth2/link-account.mjs) the implicit-link gate is `isTrustedProvider || userInfo.emailVerified`,
			// and Google and GitHub both assert emailVerified in their own OAuth response, so an empty
			// trustedProviders array does not block them; only disableImplicitLinking does. `enabled: true` keeps
			// the explicit flow (Settings → Account → Linked providers → Link) working, a deliberate, consented
			// action, not the implicit at-sign-in merge this guards against. The refused case surfaces as
			// `account_not_linked` on the sign-in page (login/+page.svelte) rather than a silent merge or a
			// dead-end redirect.
			// The default also requires the linking provider's email to match the signed-in user's on this same
			// explicit flow, which doesn't need it (CUR-1768), since the flow's own
			// authentication (a live session plus a completed OAuth round trip) is already stronger
			// than an email match, and a real person legitimately holds a work and a personal Hugging
			// Face account on different addresses. Safe to relax: every per-user table here keys on
			// shadowUserId (auth.ts, sha256 of Better Auth's own opaque user.id — CUR-552), never on
			// email, and Better Auth's own applyUpdateUserInfoOnLink (oauth2/link-account.mjs) excludes
			// email from what a link can update — so a link never touches user.email and can't reach
			// another account's rows.
			// A returning OAuth sign-in takes the provider's new email when it is verified and
			// nobody else holds it (refreshProviderEmail.ts). It never refuses a sign-in. (CUR-3249)
			user: {
				validateUserInfo: async (data, ctx) => {
					await refreshProviderEmail(data, ctx.context.internalAdapter);
				},
			},
			account: {
				accountLinking: {
					enabled: true,
					disableImplicitLinking: true,
					allowDifferentEmails: true,
				},
			},
			// A new session starts in the workspace the person last chose, rather than Personal.
			// The org plugin's setActive, create, accept-invitation and delete all write the session
			// through internalAdapter.updateSession, which runs update.after with the whole row; sign-out
			// deletes that row, so the choice is kept on the user (resumeWorkspace.ts). (CUR-3024)
			databaseHooks: {
				session: {
					create: {
						before: async (session) => {
							if (session.activeOrganizationId) return;
							const activeOrganizationId = await workspaceToResume(session.userId);
							if (!activeOrganizationId) return;
							return { data: { ...session, activeOrganizationId } };
						},
						// One security line per new session, which is what a sign-in is here. The
						// account is hashed by the logger; the network is hashed here, in the same domain as
						// the per-IP rate limit so the two can be matched. (CUR-4143)
						after: async (session, ctx) => {
							securityLogger.info(
								{
									event: "sign-in",
									user: session.userId,
									ipHash: hashIp(session.ipAddress, "rate-limit"),
								},
								"[security] sign-in"
							);
							// Mail the account when this device is new to it. In the background, so
							// the sign-in response never waits on the lookups or on Resend. (CUR-4181)
							let origin = publicOrigin;
							try {
								origin ??= getRequestEvent().url.origin;
							} catch {
								// no request in scope (a direct call in a test); noticeNewDevice sends nothing without one
							}
							// The device cookie rides on this sign-in's response, so the flag is read and the
							// cookie set here; only the lookup and the email run in the background. (CUR-4231)
							const account = ctx ? await newDeviceNoticeAccount(session.userId) : null;
							let deviceId: string | undefined;
							try {
								if (account && ctx) deviceId = await deviceIdForSignIn(ctx);
							} catch (err) {
								logger.warn({ err }, "[new-device-notice] device cookie failed — the sign-in stands");
							}
							if (account && deviceId)
								await runInBackground(
									noticeNewDevice({
										userId: session.userId,
										email: account.email,
										deviceId,
										userAgent: session.userAgent,
										origin,
									})
								);
						},
					},
					update: {
						after: async (session) => {
							if (!("activeOrganizationId" in session)) return;
							await rememberActiveWorkspace(
								session.userId,
								session.activeOrganizationId as string | null | undefined
							);
						},
					},
				},
			},
			// Google and GitHub gate independently — each is simply absent from the sign-in screen when
			// its own client id is unset, same posture as every other optional provider here.
			socialProviders: {
				...(config.GOOGLE_CLIENT_ID
					? {
							google: {
								clientId: config.GOOGLE_CLIENT_ID,
								clientSecret: config.GOOGLE_CLIENT_SECRET,
							},
						}
					: {}),
				...(config.GITHUB_CLIENT_ID
					? {
							github: {
								clientId: config.GITHUB_CLIENT_ID,
								clientSecret: config.GITHUB_CLIENT_SECRET,
							},
						}
					: {}),
			},
			plugins: [
				// per-person staff roles for /chat/admin; what each role may do is adminRoles.ts.
				// No role holds `user:impersonate`, so impersonation is off. (CUR-3990)
				admin({ ac: staffAc, roles: staffRoles, defaultRole: "user", adminRoles: ["admin"] }),
				passkey({
					rpID: passkeyRpId,
					rpName: "Alpha",
					// Every host sign-in answers on. The RP ID stays the apex, so one credential
					// works on both. (CUR-1067)
					origin: passkeyOrigins,
				}),
				emailOTP({
					sendVerificationOTP,
					// 10 min, not Better Auth's 5-min default — 5-15 min is the commonly cited range for
					// EMAIL codes specifically (NIST's 10-min ceiling is for SMS/voice, not email), and
					// checking an inbox has more real-world latency than reading an SMS.
					expiresIn: 600,
				}),
				genericOAuth({
					// Conditional on OIDConfig.CLIENT_ID, same posture as Google/GitHub above, and not for
					// cosmetic consistency: a genericOAuth provider whose discoveryUrl fails to resolve throws out
					// of runPluginInit (better-auth/dist/context/helpers.mjs, a plain sequential loop with no
					// per-plugin try/catch), which aborts createAuthContext() for the whole instance. With this
					// always on, one unreachable or misconfigured HF OIDC endpoint would take down passkey,
					// email-OTP, Google and GitHub sign-in too, not just HF. An empty `config: []` is
					// genericOAuth's own no-op path (its init() loop never runs), per the installed plugin source.
					// Since Better Auth 1.7.10 a configured HF entry whose discovery fetch fails at startup is
					// skipped, not thrown (CUR-2128, authStartup.ts).
					config: hfClientId
						? [
								huggingFaceOAuthConfig({
									providerUrl: OIDConfig.PROVIDER_URL,
									clientId: hfClientId,
									clientSecret: OIDConfig.CLIENT_SECRET,
									scopes: OIDConfig.SCOPES.split(" ").filter(Boolean),
								}),
								...(mockOidc.register ? [mockOidc.config] : []),
							]
						: mockOidc.register
							? [mockOidc.config]
							: [],
				}),
				// A workspace IS a Better Auth "organization" (CUR-550) — see the schema.ts header comment
				// for why creatorRole is "admin" rather than the plugin's own "owner" default. That is the
				// whole mechanism behind the two roles, admin and member (admin/member permission sets are
				// the plugin's built-in defaults; "owner" is never assigned).
				organization({
					creatorRole: "admin",
					// See ORG_ROLES above — the built-in admin role can't delete its own workspace. (CUR-827)
					roles: ORG_ROLES,
					// Unset defaults to NO CAP (the installed plugin's over-limit check only fires
					// for a number/function, and `undefined` matches neither branch) — any signed-in user
					// could create unlimited workspaces, each able to send up to invitationLimit's own
					// 100-per-org default. 5 is generous for a real admin managing a few teams/customers and
					// small enough to bound the "many orgs" vector; pairs with workspaceInviteRate.ts's
					// per-user invite counter below, which bounds the other half (invites spread across many
					// target addresses within those orgs). (CUR-912)
					organizationLimit: 5,
					// The three switches, registered as additional fields on the plugin's OWN
					// organization model — so createOrganization/updateOrganization/getFullOrganization all
					// read and write them natively, rather than a parallel table only this app's routes know
					// to join. Canonical value lists live in workspacePermissions.ts; defaultValue is each
					// list's own first entry, not a restated literal (`defaultValue` note in the installed
					// DBFieldAttribute type: it does NOT rely on a database-level default — Better Auth's own
					// adapter resolves it at record-creation time — so this must actually be set, not left to
					// schema.ts's column DEFAULT to cover).
					//
					// required: false, NOT true: `required` gates the request body schema (toZodSchema), not just
					// DB-level NOT NULL, so `required: true` here would make every createOrganization call missing
					// these fields 400 with "expected string, received undefined", including the create-workspace
					// form, which has no reason to know about these switches. `defaultValue` still fills the
					// column when the field is omitted; `required` only decides whether omitting it is legal. (CUR-826)
					schema: {
						organization: {
							additionalFields: {
								joinMethod: { type: "string", required: false, defaultValue: JOIN_METHODS[0] },
								configChangeRule: {
									type: "string",
									required: false,
									defaultValue: CONFIG_CHANGE_RULES[0],
								},
								rulesVisibility: {
									type: "string",
									required: false,
									defaultValue: RULES_VISIBILITIES[0],
								},
							},
						},
					},
					sendInvitationEmail: async (data, request) => {
						// Same PUBLIC_ORIGIN-or-request-origin fallback as auth.ts's own OIDC redirect URI
						// (getOIDCClient) — publicOrigin is unset in local dev; request is the live invite
						// call's own Request, so its origin is always the right one to fall back to.
						const origin = publicOrigin || (request ? new URL(request.url).origin : undefined);
						const acceptUrl = new URL(
							`${base}/workspace/accept/${data.id}`,
							origin ?? "http://localhost:5173"
						).toString();
						await sendWorkspaceInvitationEmail({
							id: data.id,
							email: data.email,
							organizationName: data.organization.name,
							inviterEmail: data.inviter.user.email,
							acceptUrl,
						});
					},
					// The only durable record of a workspace deletion, since there's no per-workspace
					// audit table (admin_audit is the SITE admin console's own, a different actor namespace —
					// see its schema.ts header comment — not reused here for that reason). (CUR-827)
					organizationHooks: {
						// Only a join method with a flow behind it can be stored, so no workspace
						// reads as joinable a way nobody can use. (CUR-3021)
						beforeCreateOrganization: async ({ organization }) => {
							refuseJoinMethodWithoutAFlow(organization.joinMethod);
							refuseUnsendableWorkspaceName(organization.name);
						},
						beforeUpdateOrganization: async ({ organization }) => {
							refuseJoinMethodWithoutAFlow(organization.joinMethod);
							refuseUnsendableWorkspaceName(organization.name);
						},
						// The per-inviter daily cap (CUR-912) refuses before the invitation row
						// exists. Counting it in the send path would let the row through and skip the email,
						// leaving the admin a Pending invite nobody would ever receive. (CUR-2835)
						beforeCreateInvitation: async ({ invitation, inviter }) => {
							await refuseOverInviteCaps(inviter, invitation.email);
						},
						// The delete nulls organization_id on its chats, so they are stamped with the
						// workspace's id and name first and list under "Former: <name>" rather than in Personal. (CUR-3040)
						beforeDeleteOrganization: async ({ organization }) => {
							const stamped = await stampDeletedWorkspace(organization.id, organization.name);
							logger.info(
								{ organizationId: organization.id, conversations: stamped },
								"[org] stamped chats before workspace delete (CUR-3040)"
							);
						},
						afterDeleteOrganization: async ({ organization, user }) => {
							logger.info(
								{ organizationId: organization.id, name: organization.name, byUserId: user.id },
								"[org] workspace deleted (CUR-827)"
							);
						},
					},
				}),
				...(oAuthProxyProductionURL ? [oAuthProxy({ productionURL: oAuthProxyProductionURL })] : []),
				// Alpha as an OAuth 2.1 authorization server for conversation sync. One scope,
				// opaque tokens (no JWT plugin), public PKCE clients from config/thunderbolt.ts only: the
				// seed plugin below writes them, and clientPrivileges refuses every client create, read,
				// update and delete through the plugin's own endpoints. A token it issues authenticates
				// /chat/api/v2/sync/* and nothing else (auth.ts, authenticateSyncRequest). Authorize and
				// consent 404 while thunderbolt-sync is off for the account ([...all]/+server.ts). (CUR-4312)
				oauthProvider({
					loginPage: `${base}/oauth/sign-in`,
					consentPage: `${base}/settings/connections/authorize`,
					scopes: [SYNC_SCOPE, "offline_access"],
					grantTypes: ["authorization_code", "refresh_token"],
					disableJwtPlugin: true,
					allowDynamicClientRegistration: false,
					clientPrivileges: () => false,
					cachedTrustedClients: new Set(SYNC_CLIENTS.map((c) => c.clientId)),
					prefix: { opaqueAccessToken: SYNC_ACCESS_TOKEN_PREFIX, refreshToken: SYNC_REFRESH_TOKEN_PREFIX },
					accessTokenExpiresIn: 3600,
				}),
				syncClientsPlugin(),
				// MUST be last — bridges Better Auth's internal Set-Cookie responses into SvelteKit's own
				// event.cookies for any call made through $app/server's request-scoped event (e.g. the
				// authenticateRequest bridge in auth.ts calling auth.api.getSession). Better Auth's own
				// SvelteKit integration warns at runtime if this isn't the final plugin.
				sveltekitCookies(getRequestEvent),
			],
	});
}

// Rebuilds after a failed startup instead of serving a rejected context until the instance recycles
// (CUR-2128).
export const getAuth = memoizeAuthUntilRejected(buildAuth);
