/**
 * The sign-in chooser (CUR-434). chat-ui's own Hugging Face redirect no longer answers at this path
 * (CUR-1961); Hugging Face is one of the Better Auth providers offered here.
 */
import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { config } from "$lib/chat/server/config";
import { OIDConfig } from "$lib/chat/server/oidcConfig";

// `next` names where to return the visitor once sign-in completes — set by every server
// route that bounces an unauthenticated visitor here (settings/account, settings/workspace,
// workspace/accept/[id]), all as `event.url.pathname + event.url.search`, so it's always a bare
// in-app path, never a full URL. Validated the same way on the way back out: must start with `base`,
// or it's dropped — a value from ANYONE's query string is untrusted input, and accepting an
// off-origin or protocol-relative ("//evil.com") value here would be an open redirect. Ignoring
// `next` drops an invitation silently: a new visitor who signs up via the accept-invitation redirect
// lands on the bare app root with the invitation never accepted and nothing on screen saying so
// (CUR-960).
//
// On the chat surface `base` is "", so the prefix check alone would admit `//evil.com` (CUR-4448).
// Protocol-relative values, and any backslash or control character (browsers read `/\evil.com` as
// another host), are refused on both surfaces, the same rule as auth.ts's sanitizeReturnPath.
function safeNext(raw: string | null): string | undefined {
	if (!raw || !raw.startsWith(`${base}/`) || raw.startsWith("//")) return undefined;
	// eslint-disable-next-line no-control-regex
	return /[\\\x00-\x1f\x7f]/.test(raw) ? undefined : raw;
}

export const load: PageServerLoad = async (event) => {
	const next = safeNext(event.url.searchParams.get("next"));

	if (event.locals.user) {
		throw redirect(302, next ?? `${base}/`);
	}

	return {
		// All three OAuth providers are independently optional (betterAuth.ts / oidcConfig.ts) — only
		// passkey and email-OTP are always configured. Hugging Face is configured only when
		// OIDConfig.CLIENT_ID is set (CUR-605); otherwise a button rendered unconditionally would error on click. Same `!!OIDConfig.CLIENT_ID` check
		// loginEnabled() already uses as its non-flag fallback (oidcConfig.ts).
		providers: {
			google: !!config.GOOGLE_CLIENT_ID,
			github: !!config.GITHUB_CLIENT_ID,
			huggingface: !!OIDConfig.CLIENT_ID,
		},
		next,
	};
};
