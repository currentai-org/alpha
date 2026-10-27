import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";

/**
 * The Hugging Face entry for genericOAuth.
 *
 * A failed discovery fetch stays contained to HF. Since Better Auth 1.7.10, genericOAuth's `init()`
 * logs "Discovery fetch failed" and skips the provider instead of throwing, so email OTP, passkey,
 * Google and GitHub keep working on that instance (CUR-2128).
 *
 * Endpoints still come from discovery because genericOAuth builds its ID-token verification (JWKS,
 * issuer, nonce) and its `sub`-keyed account subject only from a discovered document.
 * `requireIdTokenVerification` makes that a requirement: a document without a usable issuer and
 * jwks_uri skips HF too, so a degraded instance never accepts an HF ID token unverified. Failing HF
 * sign-in outright on that instance is the safer outcome.
 */
export function huggingFaceOAuthConfig(opts: {
	providerUrl: string;
	clientId: string;
	clientSecret?: string;
	scopes: string[];
}): GenericOAuthConfig {
	return {
		providerId: "huggingface",
		name: "Hugging Face",
		clientId: opts.clientId,
		// A missing secret means a PUBLIC client (the __CIMD__ path, CUR-451) — optional here for the
		// same reason it's conditional in auth.ts's own getOIDCClient.
		clientSecret: opts.clientSecret || undefined,
		// Better Auth fetches this literally — unlike openid-client's discovery(), it does not
		// auto-append the well-known suffix to a bare issuer URL.
		discoveryUrl: `${opts.providerUrl}/.well-known/openid-configuration`,
		requireIdTokenVerification: true,
		scopes: opts.scopes,
	};
}

/**
 * Memoize an auth instance, but forget it once its context rejects.
 *
 * Better Auth starts building its context when the instance is created and every request awaits
 * that one promise, so a single failed startup rejects every request until the serverless instance
 * recycles. So a startup failure would otherwise persist for the instance's lifetime. Dropping the
 * instance lets the next request build a fresh one.
 */
export function memoizeAuthUntilRejected<T extends { $context: Promise<unknown> }>(build: () => T): () => T {
	let current: T | undefined;
	return () => {
		if (current) return current;
		const built = build();
		current = built;
		built.$context.catch(() => {
			if (current === built) current = undefined;
		});
		return built;
	};
}
