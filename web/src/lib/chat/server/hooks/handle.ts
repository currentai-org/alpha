import type { Handle, RequestEvent } from "@sveltejs/kit";
import { error } from "@sveltejs/kit";
import { collections } from "$lib/chat/server/database";
import { base } from "$lib/chat/paths";
import { CHAT_ROUTE_ROOT, chatRoutePath } from "$lib/surface";
import { dev } from "$app/environment";
import {
	authenticateRequest,
	loginEnabled,
	refreshSessionCookie,
} from "$lib/chat/server/auth";
import { ERROR_MESSAGES } from "$lib/chat/stores/errors";
import { addWeeks } from "date-fns/addWeeks";
import { logger } from "$lib/chat/server/logger";
import { resolveApiCorsOrigin } from "$lib/chat/server/hooks/corsOrigin";
import { runWithRequestContext, updateRequestContext } from "$lib/chat/server/requestContext";
import { hubCallSummary } from "$lib/chat/server/storage/hubFetch";
import { config, ready } from "$lib/chat/server/config";
import {
	accountFlagValues,
	FUZZ_OVERRIDE_KEY_COOKIE,
	fuzzOverrideAuthorized,
	fuzzOverrideEnabled,
} from "$lib/chat/server/flags";
import { flagEmail } from "$lib/chat/server/flagEmail";
import {
	ACCOUNT_ROLLOUT_PROBE_HEADER,
	accountRolloutProbeEnabled,
} from "$lib/chat/server/accountRolloutProbe";
import { EVAL_LAYERS_COOKIE, parseEvalLayers } from "$lib/chat/server/evalLayers";
import { applySyncCors, isSyncCorsPath, syncPreflight } from "$lib/chat/server/sync/syncCors";
import { isSyncClientOrigin } from "../../../../../config/thunderbolt";

type HandleInput = Parameters<Handle>[0];

// An instance's first chat request can spend over a second before its session resolves
// (CUR-2843). This times the three awaits ahead of that point once per instance, as a
// `leg: 'boot'` line beside hooks.server.ts's own stages. Each `*DoneMs` counts from the request
// reaching this handle, so the gaps between them are the stages.
let firstChatRequestTimed = false;

/** Where an unauthenticated forced-login redirect sends someone: the sign-in chooser at `/login`
 *  (CUR-434). chat-ui's own Hugging Face redirect is gone (CUR-1961). */
async function redirectUnauthenticated(event: RequestEvent): Promise<Response> {
	return new Response(null, {
		status: 302,
		headers: { location: `${base}/login${event.url.search}` },
	});
}

export async function handleRequest({ event, resolve }: HandleInput): Promise<Response> {
	// Generate a unique request ID for this request
	const requestId = crypto.randomUUID();

	// Run the entire request handling within the request context
	return runWithRequestContext(
		async () => {
			// The chat route this request resolves to. On the chat surface (CUR-4448) one route answers at
			// both `/x` and, for reserved paths, `/chat/x`, so every path check below reads this rather
			// than the raw URL; on the site surface it IS the raw URL.
			const routePath = chatRoutePath(event.url.pathname);
			const timeStages = !firstChatRequestTimed;
			firstChatRequestTimed = true;
			const stageStart = performance.now();
			const stageMs: Record<string, number> = {};
			const markStage = (name: string) => {
				if (timeStages) stageMs[name] = Math.round(performance.now() - stageStart);
			};
			// coop-review-plane Step 4a: the INTERNAL screening endpoint owns its OWN bearer gate
			// (constant-time; 401/503) and must skip everything below — the model-registry gate, the
			// DB-backed config refresh, authenticateRequest (which treats any `Authorization: Bearer …` on
			// an API path as an HF token and POSTs it to huggingface.co/api/whoami-v2, 401-ing the agent),
			// and the AUTOMATIC_LOGIN redirect. Exact-path early return — NEVER a prefix — placed as the
			// FIRST statement inside the request context so the detector's log lines keep their request id.
			// See routes/chat/api/safety/screen/+server.ts and its spec (asserts zero HF, zero DB, zero redirects).
			if (routePath === `${CHAT_ROUTE_ROOT}/api/safety/screen`) {
				return resolve(event);
			}

			// A registered sync client's preflight, answered here because no route handles
			// OPTIONS. Nothing below (models, config, auth) has any bearing on it. (CUR-4312)
			const syncCors = isSyncCorsPath(routePath);
			if (syncCors && event.request.method === "OPTIONS") {
				return syncPreflight(event.request.headers.get("origin"));
			}

			// Gate requests on the model registry — a no-op once built. When the load-time build failed
			// (upstream blip), this RETRIES it, so a failed top-level await never leaves the
			// instance permanently unusable (see ensureModelsReady). A failure
			// here 500s only THIS request; a later one retries. Imported DYNAMICALLY on purpose: a
			// static import would pull models.ts (and its catalog fetch) into the hooks boot graph,
			// making even the healthcheck wait on the upstream — lazily loaded, the model-free
			// surfaces below stay independent of upstream health.
			//
			// Model-free exemptions: ops probes (healthcheck, metrics — needed MOST during an
			// upstream failure), the crons, public/boot endpoints (contribute, public-config),
			// .well-known, CORS preflights (they must reach the CORS/header handling below; no app
			// route handles OPTIONS, and SvelteKit does not map OPTIONS to GET), and the self-gated
			// /admin panels (reports/export are model-free ops surfaces; the tuning pages do read the
			// registry and surface their own error while it's empty). HEAD is deliberately NOT
			// exempt: SvelteKit dispatches HEAD to the route's GET handler (body stripped), so a HEAD
			// would execute model-dependent code. Everything else — every page render (the layout
			// load reads the registry) and the chat/API surface — must not run against an empty
			// registry. /api/warm is NOT exempt on purpose: each warm ping (cron or client) doubles
			// as a heal attempt.
			{
				const p = routePath;
				const modelFree =
					event.request.method === "OPTIONS" ||
					p.endsWith("/healthcheck") ||
					p.endsWith("/metrics") ||
					p.endsWith("/api/cleanup") ||
					p.endsWith("/api/contribute") ||
					p.endsWith("/api/v2/public-config") ||
					p.includes("/.well-known/") ||
					p.startsWith(`${CHAT_ROUTE_ROOT}/admin`);
				if (!modelFree) {
					const { ensureModelsReady } = await import("$lib/chat/server/models");
					try {
						await ensureModelsReady();
					} catch (e) {
						const wantsHtml =
							event.request.method === "GET" &&
							!routePath.startsWith(`${CHAT_ROUTE_ROOT}/api/`) &&
							(event.request.headers.get("accept")?.includes("text/html") ?? true);
						if (dev && wantsHtml) {
							error(
								503,
								"Local /chat is not configured (missing DATABASE_URL, OPENAI_BASE_URL, or related secrets). The /alpha landing demo runs without them — use http://127.0.0.1:5199/alpha. To run real /chat locally, use `pnpm dev:local` (Doppler)."
							);
						}
						throw e;
					}
				}
			}
			markStage("modelsDoneMs");

			// RETURN the inner promise rather than calling it and dropping the result.
			// checkForUpdates is async (config.ts:53) and awaits isConfigStale/updateConfig, so the
			// braces made the outer `await` resolve as soon as the call STARTED — a rejection in the
			// config refresh became an unhandled rejection on every request that took this path.
			await ready.then(() => config.checkForUpdates());
			markStage("configDoneMs");

			logger.debug(
				{
					locals: event.locals,
					url: event.url.pathname,
					params: event.params,
					request: event.request,
				},
				"Request received"
			);

			function errorResponse(status: number, message: string) {
				const sendJson =
					event.request.headers.get("accept")?.includes("application/json") ||
					event.request.headers.get("content-type")?.includes("application/json");
				return new Response(sendJson ? JSON.stringify({ error: message }) : message, {
					status,
					headers: {
						"content-type": sendJson ? "application/json" : "text/plain",
					},
				});
			}

			// Reject URI paths with invalid percent-encoding (e.g. overlong UTF-8 like %c0%af used by
			// path-traversal scanners) before any auth logic. SvelteKit only turns these into a 400 inside
			// resolve(); a redirect thrown by the login branch below would reach them first. Ported from
			// upstream chat-ui 72976c3 (CUR-2117).
			try {
				decodeURIComponent(event.url.pathname);
			} catch {
				return errorResponse(400, "Malformed URI");
			}

			// CUR-1044 local fuzzing-harness flag override. `fuzz_override` is a plain, unsigned
			// `key:true,key2:false` cookie the harness sets on its own Playwright/Stagehand context — never
			// read at all unless fuzzOverrideEnabled() is true, which is itself hard-gated off in
			// production in flags.ts. Parsed into the request context (not `locals`) because flags.ts's
			// deployment-level reads (flagEnabledOr) are synchronous with no request parameter to thread
			// this through otherwise. Parsed BEFORE authenticateRequest, so an override reaches every
			// flag read on the request, the sign-in decision included (CUR-2451).
			// On a hosted preview the request must also prove it is the harness.
			// The deployment check comes first so production never reads the key cookie at all. (CUR-3516)
			if (fuzzOverrideEnabled() && (await fuzzOverrideAuthorized(event.cookies.get(FUZZ_OVERRIDE_KEY_COOKIE)))) {
				const raw = event.cookies.get("fuzz_override");
				if (raw) {
					const parsed: Record<string, boolean> = {};
					for (const pair of raw.split(",")) {
						const [k, v] = pair.split(":");
						if (k?.trim()) parsed[k.trim()] = v?.trim() === "true";
					}
					updateRequestContext({ fuzzOverride: parsed });
				}
				// The layer test's switches, behind the same gate. (CUR-2139)
				const layers = parseEvalLayers(event.cookies.get(EVAL_LAYERS_COOKIE));
				if (layers) updateRequestContext({ evalLayers: layers });
			}

			const isApi = routePath.startsWith(`${CHAT_ROUTE_ROOT}/api/`);
			const auth = await authenticateRequest(
				event.request.headers,
				event.cookies,
				event.url,
				isApi
			);
			markStage("authDoneMs");
			if (timeStages) {
				logger.info(
					{ leg: "boot", stage: "first-chat-request", ...stageMs },
					"[boot] stage timing"
				);
			}

			event.locals.sessionId = auth.sessionId;
			event.locals.sync = auth.sync;
			event.locals.guestSessionMinted = Boolean(auth.mintedSession) && !auth.user;

			// No tester cookie is set here from `?ph_test=<name>` (CUR-1278): flags evaluate server-side
			// against the real distinct id, with person-selection in the flag's own release conditions (see
			// the note in flags.ts). A name the visitor types is not an identity. `?ph_test=1` and
			// `?ph_test=<label>` still work: analytics.ts reads the query string directly, client-side, to
			// mark internal traffic.

			// Accounts are ADDITIVE, not required (CUR-246). The `else` branch below would redirect
			// everything outside a short allowlist even with AUTOMATIC_LOGIN off, so merely having an OAuth
			// client configured (loginEnabled()) would make the app login-REQUIRED, contradicting "No account
			// needed". Gating the whole thing on AUTOMATIC_LOGIN === "true" makes the variable mean what its
			// name says: with it off, a signed-out visitor is never redirected here at all.
			if (
				loginEnabled() &&
				config.AUTOMATIC_LOGIN === "true" &&
				!auth.user &&
				!auth.sync &&
				!routePath.startsWith(`${CHAT_ROUTE_ROOT}/.well-known/`)
			) {
				// Always redirect to the OAuth flow — except on the pages that would become unreachable
				// if we did. Admin panels self-gate (adminAuth password / Bearer export); Better Auth's
				// own routes (CUR-434) need the exemption too, or a real browser GET back from Hugging
				// Face's OAuth callback redirect-loops into this branch before Better Auth's own
				// catch-all ever handles it.
				if (
					!routePath.startsWith(`${CHAT_ROUTE_ROOT}/login`) &&
					!routePath.startsWith(`${CHAT_ROUTE_ROOT}/healthcheck`) &&
					!routePath.startsWith(`${CHAT_ROUTE_ROOT}/admin`) &&
					!routePath.startsWith(`${CHAT_ROUTE_ROOT}/api/auth`)
				) {
					// To get the same CSRF token after callback
					refreshSessionCookie(event.cookies, auth.secretSessionId);
					return await redirectUnauthenticated(event);
				}
			}

			event.locals.user = auth.user || undefined;
			event.locals.token = auth.token;

			// Update request context with user after authentication
			if (auth.user?.username) {
				updateRequestContext({ user: auth.user.username });
			}

			// This account's own flag answers, ahead of the deployment snapshot. The id is the
			// authenticated account's, never anything the request carries (flags.ts, CUR-1278). (CUR-2463)
			if (auth.user?._id) {
				const accountFlags = await accountFlagValues(auth.user._id.toString(), flagEmail(auth.user));
				if (accountFlags) updateRequestContext({ accountFlags });
			}

			// Admin comes only from the account's stored isAdmin flag, which the resolver reads.
			event.locals.isAdmin = auth.isAdmin;

			// CSRF protection
			const requestContentType = event.request.headers.get("content-type")?.split(";")[0] ?? "";
			/** https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form#attr-enctype */
			const nativeFormContentTypes = [
				"multipart/form-data",
				"application/x-www-form-urlencoded",
				"text/plain",
			];

			if (event.request.method === "POST") {
				if (nativeFormContentTypes.includes(requestContentType)) {
					const origin = event.request.headers.get("origin");

					if (!origin) {
						return errorResponse(403, "Non-JSON form requests need to have an origin");
					}

					const validOrigins = [
						new URL(event.request.url).host,
						...(config.PUBLIC_ORIGIN ? [new URL(config.PUBLIC_ORIGIN).host] : []),
					];

					// The sync client's token exchange and revoke are form posts from its own
					// origin. They carry no cookie, so there is no ambient session for a forged post to use. (CUR-4312)
					const syncClientPost = syncCors && isSyncClientOrigin(origin);
					if (!syncClientPost && !validOrigins.includes(new URL(origin).host)) {
						return errorResponse(403, "Invalid referer for POST request");
					}
				}
			}

			// A request that MINTED a session hands the browser that cookie, whatever its
			// method. This is what lets auth.ts avoid (IP, User-Agent) coalescing: a cookie-less GET that
			// minted a session without telling the browser would leave every later request cookie-less
			// and correlated by fingerprint, which lets two strangers on one NAT share a session.
			//
			// The document response does not carry the cookie for the page's own fetches:
			// `hooks.server.ts` routes to this pipeline only for `/chat` and `/chat/**`, and the page a
			// visitor opens is `/alpha/chat`, which never reaches chat auth at all. A cold load makes
			// exactly ONE chat-pipeline request, `GET /chat/api/warm`, so that response sets the cookie.
			// See auth.ts's mintAnonymousSession.
			//
			// Deliberately separate from the POST/login branch below rather than folded into its
			// condition: that branch also extends the session's expiry, which a session created
			// milliseconds ago does not need, and the two have different reasons to run.
			//
			// Except on api/fetch-url (CUR-3191): that route refuses a request that just minted, so it
			// answers with no Set-Cookie and its responses never carry a session. (CUR-1645)
			if (auth.mintedSession && !auth.sync && routePath !== `${CHAT_ROUTE_ROOT}/api/fetch-url`) {
				refreshSessionCookie(event.cookies, auth.secretSessionId);
			}

			// A sync request (CUR-4312) has no browser session to extend.
			if (
				!auth.sync &&
				(event.request.method === "POST" ||
					routePath.startsWith(`${CHAT_ROUTE_ROOT}/login`) ||
					routePath.startsWith(`${CHAT_ROUTE_ROOT}/login/callback`))
			) {
				// if the request is a POST request or login-related we refresh the cookie
				refreshSessionCookie(event.cookies, auth.secretSessionId);

				await collections.sessions.updateOne(
					{ sessionId: auth.sessionId },
					{ $set: { updatedAt: new Date(), expiresAt: addWeeks(new Date(), 2) } }
				);
			}

			// CUR-246 (porting spike/cur-230-everything-on 61141b4d): the SECOND login gate, and the one
			// the redirect above was hiding — this 401s every non-GET from a signed-out visitor (create a
			// conversation, send a message, change a setting), so enabling sign-in without narrowing this
			// one too froze the app read-only even after gate 1 was fixed. Gated on AUTOMATIC_LOGIN for
			// the same reason as gate 1: anonymous is the product here, not a fallback.
			if (
				loginEnabled() &&
				config.AUTOMATIC_LOGIN === "true" &&
				!event.locals.user &&
				!routePath.startsWith(`${CHAT_ROUTE_ROOT}/login`) &&
				!routePath.startsWith(`${CHAT_ROUTE_ROOT}/admin`) &&
				!routePath.startsWith(`${CHAT_ROUTE_ROOT}/settings`) &&
				// Better Auth's own sign-in surface (CUR-434) is POST-heavy by nature — email-OTP
				// submission, passkey registration/authentication, the social-provider callback — and
				// every one of those happens BEFORE event.locals.user exists. This exemption stays
				// UNCONDITIONAL (not just under AUTOMATIC_LOGIN) because a visitor has to be able to
				// reach sign-in when they choose to, not only when forced.
				!routePath.startsWith(`${CHAT_ROUTE_ROOT}/api/auth`) &&
				!["GET", "OPTIONS", "HEAD"].includes(event.request.method)
			) {
				return errorResponse(401, ERROR_MESSAGES.authOnly);
			}

			let replaced = false;

			const response = await resolve(event, {
				transformPageChunk: (chunk) => {
					// SvelteKit does not load env variables from .env in the app.html template, so substitute the id here
					if (replaced || !chunk.html.includes("%gaId%")) {
						return chunk.html;
					}
					replaced = true;

					return chunk.html.replace("%gaId%", config.PUBLIC_GOOGLE_ANALYTICS_ID);
				},
				filterSerializedResponseHeaders: (header) => {
					return header.includes("content-type");
				},
			});

			// Update request context with status code
			updateRequestContext({ statusCode: response.status });

			// measure-only, see accountRolloutProbe.ts. A response whose headers are immutable
			// (a fetched redirect) just goes without it. (CUR-2463)
			if (accountRolloutProbeEnabled()) {
				try {
					response.headers.set(ACCOUNT_ROLLOUT_PROBE_HEADER, "on");
				} catch {
					// immutable headers
				}
			}

			// CSP frame-ancestors (huggingface.co + Payload's Live Preview) is set once, for every
			// route, via svelte.config.js's kit.csp — SvelteKit's own resolve() above already
			// applies it, so it doesn't need to be duplicated here.

			if (
				routePath.startsWith(`${CHAT_ROUTE_ROOT}/login/callback`) ||
				routePath.startsWith(`${CHAT_ROUTE_ROOT}/login`)
			) {
				response.headers.append("Cache-Control", "no-store");
			}

			// Settings pages render on the server, and the HTML carries the visitor's session and
			// settings, so no shared cache may keep it. Set here once for the group rather than in each
			// page's load, where a second `setHeaders` of the same header throws. (CUR-908)
			if (routePath.startsWith(`${CHAT_ROUTE_ROOT}/settings`)) {
				response.headers.set("Cache-Control", "private, no-store");
			}

			if (routePath.startsWith(`${CHAT_ROUTE_ROOT}/api/`)) {
				// get origin from the request
				const requestOrigin = event.request.headers.get("origin");

				// Compare requestOrigin against the request's own host as well as config.PUBLIC_ORIGIN's
				// static origin (CUR-1172). PUBLIC_ORIGIN is one value synced to every preview deployment, so a
				// same-origin caller on an ephemeral per-PR preview would otherwise get a CORS header naming
				// develop.aipotluck.org instead of its own host. Same trusted-origin shape as the CSRF check
				// above.
				const validOrigins = [
					new URL(event.request.url).origin,
					...(config.PUBLIC_ORIGIN ? [new URL(config.PUBLIC_ORIGIN).origin] : []),
				];
				const allowedOrigin = resolveApiCorsOrigin(requestOrigin, validOrigins, { dev });

				if (allowedOrigin) {
					response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
					response.headers.set(
						"Access-Control-Allow-Methods",
						"GET, POST, PUT, PATCH, DELETE, OPTIONS"
					);
					response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
				}
			}

			logger.info(hubCallSummary(), "Request completed");

			// The registered client's origin by name on the sync and token paths, in place of
			// the same-origin answer above. (CUR-4312)
			if (syncCors) return applySyncCors(response, event.request.headers.get("origin"));

			return response;
		},
		// No client IP in the request context: it would ride onto every log line and into the log store's full
		// retention, which db/ipHash.ts and the privacy notice both say we don't do. Rate limiting and
		// contribution caps take the address directly from the event and hash it.
		{ requestId, url: event.url.pathname }
	);
}
