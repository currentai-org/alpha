import { dev } from "$app/environment";
import { env } from "$env/dynamic/private";
import { hmacSha256, timingSafeEqual } from "$lib/chat/server/crypto";

// HMAC label for the bearer compare below; not a secret, just domain separation.
const AUTH_HASH_LABEL = "cleanup-cron-auth-v1";

/** True when `request` carries `Authorization: Bearer ${CRON_SECRET}`: what Vercel's cron sends when
 *  CRON_SECRET is set (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs), and what
 *  any other scheduler sends by hand. With no secret configured it is open under `vite dev` only, and
 *  refuses everywhere else: a scheduled job that writes rows or raises alerts must not run open.
 *  Constant-time over equal-length HMAC digests, as safety/screen does, never a raw string compare
 *  against the header. */
export async function cronAuthorized(request: Request): Promise<boolean> {
	const secret = env.CRON_SECRET;
	if (!secret) return dev;
	const [supplied, expected] = await Promise.all([
		hmacSha256(AUTH_HASH_LABEL, request.headers.get("authorization") ?? ""),
		hmacSha256(AUTH_HASH_LABEL, `Bearer ${secret}`),
	]);
	return timingSafeEqual(supplied, expected);
}
