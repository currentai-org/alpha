import { APP_SURFACE, type AppSurface } from "../../surface";
import { CHAT_HOST } from "../paths";
import { DEFAULT_INSTANCE, deploymentInstance } from "./instance";

/**
 * Production serves chat on two hosts side by side, www.aipotluck.org/chat and
 * alpha.aipotluck.org/chat (chat's own host since CUR-4439), from the same deployment. Sign-in has to answer on whichever one the
 * visitor used: an OAuth redirect_uri naming the other host drops them there after the provider round
 * trip, and a passkey assertion from the other host fails its origin check.
 *
 * Every other deployment keeps its single PUBLIC_ORIGIN. alpha. is a production host only, and its
 * OAuth callbacks are registered on the production Google and GitHub clients only. An event instance
 * (CUR-3156) is production too, but alpha. is an alias of www, never of it, so it keeps its own origin.
 *
 * chat.aipotluck.org, the chat host before alpha, 308s every path to alpha before sign-in runs, so
 * it needs no entry here.
 *
 * A chat-surface build (APP_SURFACE=chat, CUR-4448) is chat's own deployment, so its PUBLIC_ORIGIN is
 * the auth origin and nothing is added: it may serve alpha. itself, or a host of its own.
 *
 * Pure and free of config imports, so the CIMD route can read the same list without loading
 * betterAuth.ts, and a test can exercise it without a live environment. (CUR-1067)
 */
/** The origins sign-in answers on, PUBLIC_ORIGIN first. Empty when PUBLIC_ORIGIN is unset (local dev). */
export function authOrigins(
	publicOrigin: string | undefined,
	env: { VERCEL_ENV?: string; INSTANCE?: string },
	surface: AppSurface = APP_SURFACE
): string[] {
	if (!publicOrigin) return [];
	const origins = [new URL(publicOrigin).origin];
	const chatOrigin = `https://${CHAT_HOST}`;
	const servesChatHost =
		surface === "site" && env.VERCEL_ENV === "production" && deploymentInstance(env) === DEFAULT_INSTANCE;
	if (servesChatHost && !origins.includes(chatOrigin)) origins.push(chatOrigin);
	return origins;
}

export type DynamicAuthBaseURL = {
	allowedHosts: string[];
	fallback: string;
	protocol: "https";
};

/**
 * Better Auth's `baseURL`. With one origin it stays the static string it has always been. With more,
 * it becomes Better Auth 1.7's dynamic form: each request's Host header is matched against
 * `allowedHosts`, and that host's origin is used for redirect URIs and trusted origins. A host outside
 * the list (the deployment's own *.vercel.app URL, the bare apex) falls back to PUBLIC_ORIGIN, which is
 * today's behaviour. Production's cookie name does not depend on it: `computeSessionCookieScope` (betterAuth.ts)
 * names it `__Host-aip.*` and sets Secure itself.
 */
export function authBaseURL(
	publicOrigin: string | undefined,
	env: { VERCEL_ENV?: string; INSTANCE?: string },
	surface: AppSurface = APP_SURFACE
): string | DynamicAuthBaseURL | undefined {
	const origins = authOrigins(publicOrigin, env, surface);
	if (!publicOrigin || origins.length < 2) return publicOrigin;
	return {
		allowedHosts: origins.map((origin) => new URL(origin).host),
		fallback: publicOrigin,
		protocol: "https",
	};
}
