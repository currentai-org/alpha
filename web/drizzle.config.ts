import { defineConfig } from 'drizzle-kit';
import { migrationDatabaseUrl } from './scripts/lib/migrationDatabaseUrl.mjs';

export default defineConfig({
	dialect: 'postgresql',
	schema: ['./src/lib/chat/server/db/schema.ts', './src/lib/cache/db/schema.ts'],
	out: './drizzle',
	dbCredentials: {
		// Shared with scripts/db-migrate.mjs, which is what `db:migrate` and `vercel-build` actually
		// run (CUR-1517) — drizzle-kit is still the tool for `generate`, and both must reach the same
		// database. The fallback order and why it exists are documented at the definition.
		url: migrationDatabaseUrl().url
	},
	strict: true
});
