// The website's CMS cache needs no database: a publish clears the receiving instance's own
// cache and every other instance refreshes on its TTL. So server start-up, on every surface, opens no
// Postgres connection and schedules no repeating timer for it. A poller that came back would do both
// within one boot, and on the chat surface (self-hosted Alpha) it would ask chat's database for a
// website table.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSurface } from '$lib/surface';

const connections: string[] = [];

function mockServerBoot(surface: AppSurface) {
	vi.doMock('$app/environment', () => ({ building: false, dev: false }));
	vi.doMock('$lib/surface', async (importOriginal) => ({
		...(await importOriginal<typeof import('$lib/surface')>()),
		APP_SURFACE: surface
	}));
	// Any postgres.js client anywhere in the boot records the URL it was opened with.
	vi.doMock('postgres', () => {
		const open = (url?: string) => {
			connections.push(String(url));
			const sql = Object.assign(async () => [], { end: async () => {}, unsafe: async () => [] });
			return sql;
		};
		return { default: open };
	});
	// Chat's own boot is not under test here: its database is chat's, and alpha needs it.
	vi.doMock('$lib/chat/server/db/client', () => ({ preconnectDb: vi.fn() }));
	vi.doMock('$lib/chat/server/env/validate', () => ({ validateEnv: vi.fn() }));
	vi.doMock('$lib/chat/server/hooks/init', () => ({ initServer: vi.fn(async () => {}) }));
	vi.doMock('$lib/chat/server/hooks/handle', () => ({ handleRequest: vi.fn() }));
}

beforeEach(() => {
	connections.length = 0;
	vi.resetModules();
	vi.useFakeTimers();
	vi.stubEnv('DATABASE_URL', 'postgres://chat:secret@chat-db.invalid:5432/chat');
	// The site-only boot checks the site's own env (website/siteOnly.ts), which needs its origin.
	vi.stubEnv('PUBLIC_ORIGIN', 'https://www.example.test');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.doUnmock('$lib/surface');
	vi.doUnmock('postgres');
});

describe.each<AppSurface>(['chat', 'site-only', 'site'])(
	'server start-up on the %s surface',
	(surface) => {
		it('starts no CMS cache poller: no repeating timer, and no Postgres connection, after a minute', async () => {
			mockServerBoot(surface);
			const { init } = await import('./hooks.server');
			const timersBefore = vi.getTimerCount();
			await init();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(vi.getTimerCount()).toBe(timersBefore);
			expect(connections).toEqual([]);
		});
	}
);
