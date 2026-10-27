// Settings → Data & privacy: the caller's OWN usage, counts only, plus the limits that apply to them.
// Same posture as workspaceUsage.ts — every query selects aggregate scalars, never message text — so
// the page can chart activity without a code path that returns content.
//
// Scope mirrors authCondition(): a signed-in user by their (shadow) userId, a guest by sessionId with
// no userId attached.

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { conversations } from "$lib/chat/server/db/schema";
import { usageLimits } from "$lib/chat/server/usageLimits";
import { RETENTION_DAYS } from "$lib/chat/constants/retention";

// Dates inside the jsonb doc are serialised as {"$dt": "<iso>"} (database.ts's doc codec), not bare strings.
export const USAGE_WINDOW_DAYS = 30;

export type AccountUsage = {
	totals: { conversations: number; messages: number; userMessages: number; characters: number };
	/** One entry per UTC day, oldest first, exactly USAGE_WINDOW_DAYS long (zero-filled). */
	daily: { date: string; messages: number }[];
	/** Messages sent in the longest conversation — what the per-conversation limit is measured against. */
	longestConversation: number;
	limits: {
		conversations: number | null;
		messagesPerConversation: number | null;
		messagesPerMinute: number | null;
		messageLength: number | null;
		/** Guests only: days before a conversation is deleted automatically. */
		retentionDays: number | null;
	};
};

export async function getAccountUsage(locals: App.Locals): Promise<AccountUsage> {
	const scope: SQL | undefined = locals.user
		? eq(conversations.userId, String(locals.user._id))
		: and(eq(conversations.sessionId, locals.sessionId), isNull(conversations.userId));

	const msgs = sql`jsonb_array_elements(coalesce(${conversations.doc}->'messages', '[]'::jsonb))`;
	const db = getDb();

	const [totalsRow] = await db
		.select({
			conversations: sql<number>`count(*)::int`,
			longest: sql<number>`coalesce(max(jsonb_array_length(coalesce(${conversations.doc}->'messages', '[]'::jsonb))), 0)::int`,
		})
		.from(conversations)
		.where(scope);

	// "Total messages" counts what the visitor sees: every conversation also holds a hidden system
	// prompt, which is left out, so 12 conversations of one exchange each read 24, not 36.
	const [userRow] = await db.execute<{ user_messages: number; messages: number; characters: number }>(sql`
		select count(*) filter (where m->>'from' = 'user')::int as user_messages,
		       count(*) filter (where m->>'from' is distinct from 'system')::int as messages,
		       coalesce(sum(length(m->>'content')) filter (where m->>'from' = 'user'), 0)::int as characters
		from ${conversations}, ${msgs} as m
		where ${scope}`);

	const since = new Date(Date.now() - (USAGE_WINDOW_DAYS - 1) * 86_400_000);
	since.setUTCHours(0, 0, 0, 0);
	const dailyRows = await db.execute<{ day: string; n: number }>(sql`
		select to_char(date_trunc('day', (m->'createdAt'->>'$dt')::timestamptz at time zone 'UTC'), 'YYYY-MM-DD') as day,
		       count(*)::int as n
		from ${conversations}, ${msgs} as m
		where ${scope} and m->>'from' = 'user' and m->'createdAt'->>'$dt' is not null
		  and (m->'createdAt'->>'$dt')::timestamptz >= ${since.toISOString()}::timestamptz
		group by 1`);

	const byDay = new Map(Array.from(dailyRows, (r) => [r.day, Number(r.n)]));
	const daily = Array.from({ length: USAGE_WINDOW_DAYS }, (_, i) => {
		const date = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
		return { date, messages: byDay.get(date) ?? 0 };
	});

	return {
		totals: {
			conversations: totalsRow?.conversations ?? 0,
			messages: Number(userRow?.messages ?? 0),
			userMessages: Number(userRow?.user_messages ?? 0),
			characters: Number(userRow?.characters ?? 0),
		},
		daily,
		longestConversation: totalsRow?.longest ?? 0,
		limits: {
			conversations: usageLimits?.conversations || null,
			messagesPerConversation: usageLimits?.messages || null,
			messagesPerMinute: usageLimits?.messagesPerMinute || null,
			messageLength: usageLimits?.messageLength || null,
			retentionDays: locals.user ? null : RETENTION_DAYS,
		},
	};
}
