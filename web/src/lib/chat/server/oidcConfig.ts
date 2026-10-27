/**
 * Hugging Face OIDC config parsing — split out of auth.ts (CUR-434) so betterAuth.ts (which reuses these
 * same values for its Hugging Face genericOAuth provider) can import them without creating a circular
 * dependency: auth.ts's authenticateRequest now imports the Better Auth instance from betterAuth.ts, so
 * betterAuth.ts can no longer import anything from auth.ts itself. This file has no dependency on
 * either, and both import from here.
 */
import { config } from "$lib/chat/server/config";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { z } from "zod";
import JSON5 from "json5";

const stringWithDefault = (value: string) =>
	z
		.string()
		.default(value)
		.transform((el) => (el ? el : value));

export const OIDConfig = z
	.object({
		CLIENT_ID: stringWithDefault(config.OPENID_CLIENT_ID),
		CLIENT_SECRET: stringWithDefault(config.OPENID_CLIENT_SECRET),
		PROVIDER_URL: stringWithDefault(config.OPENID_PROVIDER_URL),
		SCOPES: stringWithDefault(config.OPENID_SCOPES),
		// Empty means "name", because empty is what we have.
		//
		// Upstream never needs a code default: its committed .env carries
		// OPENID_NAME_CLAIM="name". Here the key is absent from .env and .env.example, so
		// this resolves to "" — and updateUser.ts builds its schema as
		// `.extend({ [OIDConfig.NAME_CLAIM]: z.string() })`, which then demands a property literally
		// named "". No provider sends one, so the OAuth CALLBACK throws
		// `ZodError: expected string, received undefined` at path [""] after the user has already
		// consented. The failure lands at the last step of the flow and names nothing recognisable.
		//
		// A default belongs here rather than in .env: env can go missing again, and this is the value
		// upstream picked anyway.
		NAME_CLAIM: stringWithDefault(config.OPENID_NAME_CLAIM)
			.transform((el) => el || "name")
			.refine((el) => !["preferred_username", "email", "picture", "sub"].includes(el), {
				message: "nameClaim cannot be one of the restricted keys.",
			}),
		TOLERANCE: stringWithDefault(config.OPENID_TOLERANCE),
		RESOURCE: stringWithDefault(config.OPENID_RESOURCE),
		ID_TOKEN_SIGNED_RESPONSE_ALG: z.string().optional(),
	})
	.parse(JSON5.parse(config.OPENID_CONFIG || "{}"));

/** PostHog flag key (CUR-246). Owner: chat. Release condition: env exact preview — so develop's
 *  preview deployment carries real sign-in while prod stays on today's env-presence behavior until
 *  someone flips it there deliberately. */
export const ACCOUNTS_FLAG = "accounts";

/**
 * Read this before flipping the `accounts` flag anywhere.
 *
 * Turning it on does not just surface a login prompt — it makes the app login-REQUIRED, because
 * `handle.ts` has TWO gates keyed on this alone: a redirect that catches almost every path, and a
 * 401 on every non-GET. So enabling sign-in without also narrowing both gates to
 * `AUTOMATIC_LOGIN === "true"` freezes anonymous use, which contradicts the product's own copy ("No
 * account needed"). That narrowing is ported into handle.ts in the SAME change as this flag
 * (CUR-246).
 *
 * The three v6-migration fixes below are in auth.ts. They are unreachable while this is
 * false, and each hides the next when it isn't (CUR-230 has the ordered chain).
 *
 * Fallback (flag never polled, or PostHog hasn't defined this key yet) is today's behavior —
 * env-presence — not OFF, because the HF-only flow already reads live in production and a cold-start
 * false would silently pull sign-in out from under it.
 */
export function loginEnabled(): boolean {
	return flagEnabledOr(ACCOUNTS_FLAG, () => !!OIDConfig.CLIENT_ID);
}
