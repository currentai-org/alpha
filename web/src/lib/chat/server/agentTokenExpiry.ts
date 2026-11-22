/** How long the agent service bearer token has left, read from its own `exp` claim.
 *
 *  The hosted token is a JWT minted with a fixed lifetime, and the agent service refuses every task once
 *  it passes `exp`. Nothing else reads that date, so this decodes it without verifying the signature (the
 *  agent service does that) and never returns or logs any part of the token itself. */

/** Alert this many days before the token expires: enough for a mint, a Doppler write and a redeploy. */
export const AGENT_TOKEN_WARN_DAYS = 21;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AgentTokenExpiry = { expiresAt: string; daysLeft: number };

/** The token's expiry and the whole and fractional days left at `now`, or null when the token is empty,
 *  is not a JWT, or carries no numeric `exp` (a self-hosted operator's opaque token, which never expires
 *  on a schedule we know). A token already past `exp` gives a negative `daysLeft`. */
export function agentTokenExpiry(token: string, now: number = Date.now()): AgentTokenExpiry | null {
	const parts = token.trim().split(".");
	if (parts.length !== 3 || !parts[1]) return null;
	let exp: unknown;
	try {
		exp = (JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown }).exp;
	} catch {
		return null;
	}
	if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
	const expMs = exp * 1000;
	return { expiresAt: new Date(expMs).toISOString(), daysLeft: (expMs - now) / DAY_MS };
}
