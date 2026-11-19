// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
/**
 * The sign-in chooser. chat-ui's own Hugging Face redirect no longer answers at this path;
 * Hugging Face is one of the Better Auth providers offered here.
 */
import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { config } from "$lib/chat/server/config";
import { OIDConfig } from "$lib/chat/server/oidcConfig";
import { ORG_OIDC_ENV_KEYS, orgOidcProvider } from "$lib/chat/server/orgOidc";
import { getAuth } from "$lib/chat/server/betterAuth";
import { emailPasswordSignIn } from "$lib/chat/server/mailer";
import { passwordSignUpClosed } from "$lib/chat/server/selfHostSignUp";

// `next` names where to return the visitor once sign-in completes — set by every server
// route that bounces an unauthenticated visitor here (settings/account, settings/workspace,
// workspace/accept/[id]), all as `event.url.pathname + event.url.search`, so it's always a bare
// in-app path, never a full URL. Validated the same way on the way back out: must start with `base`,
// or it's dropped — a value from ANYONE's query string is untrusted input, and accepting an
// off-origin or protocol-relative ("//evil.com") value here would be an open redirect. Ignoring
// `next` drops an invitation silently: a new visitor who signs up via the accept-invitation redirect
// lands on the bare app root with the invitation never accepted and nothing on screen saying so.
//
// On the chat surface `base` is "", so the prefix check alone would admit `//evil.com`.
// Protocol-relative values, and any backslash or control character (browsers read `/\evil.com` as
// another host), are refused on both surfaces, the same rule as auth.ts's sanitizeReturnPath.
function safeNext(raw: string | null): string | undefined {
	if (!raw || !raw.startsWith(`${base}/`) || raw.startsWith("//")) return undefined;
	// eslint-disable-next-line no-control-regex
	return /[\\\x00-\x1f\x7f]/.test(raw) ? undefined : raw;
}

/**
 * The organisation login's button name, offered only when Better Auth actually registered that
 * provider. Its discovery runs at auth startup and a failed fetch or a JWKS-less document skips it
 * (orgOidc.ts), so complete env alone would draw a button whose click finds no provider.
 */
async function orgProviderName(): Promise<string | null> {
	const org = orgOidcProvider(Object.fromEntries(ORG_OIDC_ENV_KEYS.map((k) => [k, config[k]])));
	if (!org.register) return null;
	try {
		const ctx = (await getAuth().$context) as { socialProviders?: Array<{ id: string }> };
		return ctx.socialProviders?.some((p) => p.id === org.config.providerId) ? org.name : null;
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async (event) => {
	const next = safeNext(event.url.searchParams.get("next"));

	if (event.locals.user) {
		throw redirect(302, next ?? `${base}/`);
	}

	return {
		// All three OAuth providers are independently optional (betterAuth.ts / oidcConfig.ts) — only
		// passkey and email-OTP are always configured. Hugging Face is configured only when
		// OIDConfig.CLIENT_ID is set; otherwise a button rendered unconditionally would error on click. Same `!!OIDConfig.CLIENT_ID` check
		// loginEnabled() already uses as its non-flag fallback (oidcConfig.ts).
		providers: {
			google: !!config.GOOGLE_CLIENT_ID,
			github: !!config.GITHUB_CLIENT_ID,
			huggingface: !!OIDConfig.CLIENT_ID,
			// a self-hosted Alpha's own organisation login, offered under the name its operator
			// gave it, and only once Better Auth has registered it.
			org: await orgProviderName(),
		},
		// "password" on a self-host with no mailer, where nobody could receive a code and Better
		// Auth's email-and-password sign-in is on in its place (mailer.ts); "code" everywhere else.
		emailSignIn: emailPasswordSignIn() ? ("password" as const) : ("code" as const),
		// on that same self-host, password sign-up closes once an account exists unless
		// ALPHA_OPEN_SIGNUP=true; the page says so rather than offering a form that will be refused.
		signUpClosed: await passwordSignUpClosed(),
		next,
	};
};
