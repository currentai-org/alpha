// How many chat turns one account may send in any 24 hours. Read by
// `src/lib/chat/server/db/chatTurnAllowance.ts`; a team account gets `STAFF_TIER.chatTurnsPerDay`
// (`src/lib/chat/server/teamAccount.ts`) instead.
//
// What it trades: the service-wide cap (GLOBAL_DAILY_REQUEST_CAP) protects the day's compute budget, but
// one account could spend all of it and leave a full room with nothing. This cap bounds one account's
// share. Set it too low and a heavy but honest user is stopped mid-task; too high and it bounds nothing.
//
// 200 sits well above real use. Over a 60-day production window, production's
// busiest account-day held 55 turns, the 99th percentile 15 and the median 1, across 1,411 account-days
// (`pnpm db:prod-read`, turns counted from stored conversations; deleted conversations are not in it).
// No account-day in that window would have reached 200.

/** Turns one account (or one guest session) may send in any 24 hours. */
export const CHAT_TURNS_PER_DAY = 200;
