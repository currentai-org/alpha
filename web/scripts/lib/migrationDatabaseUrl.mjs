/**
 * The connection string migrations run against, resolved once and read by both
 * `drizzle.config.ts` and `scripts/db-migrate.mjs`.
 *
 * It lives here rather than inline in the config because two readers of a hand-copied fallback
 * chain is how one of them quietly ends up a variable behind the other — and the failure that
 * produces is a migration run against the wrong database, which is not a failure anyone wants to
 * debug from a build log.
 *
 * Migrations want a DIRECT (non-pooled) connection for DDL; on Vercel the Neon integration provides
 * POSTGRES_URL_NON_POOLING. Falling back through it, then the pooled URL, means `db:migrate` runs in
 * the Vercel build without a copied secret.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ url: string, from: string | null }} `from` names which variable supplied it, which is
 *   the one thing a failed migration's log most needs and cannot otherwise be recovered.
 */
export function migrationDatabaseUrl(env = process.env) {
	for (const key of ["DATABASE_URL", "POSTGRES_URL_NON_POOLING", "POSTGRES_URL"]) {
		if (env[key]) return { url: env[key], from: key };
	}
	return { url: "", from: null };
}
