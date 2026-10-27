import { z } from "zod";
import { config } from "$lib/chat/server/config";
import JSON5 from "json5";
import { sanitizeJSONEnv } from "$lib/chat/server/envParse";
import { STAFF_TIER, isTeamAccount } from "$lib/chat/server/teamAccount";

// RATE_LIMIT is the legacy way to define messages per minute limit
const usageLimitsSchema = z
	.object({
		conversations: z.coerce.number().optional(), // how many conversations
		messages: z.coerce.number().optional(), // how many messages in a conversation
		messageLength: z.coerce.number().optional(), // how long can a message be before we cut it off
		messagesPerMinute: z
			.preprocess((val) => {
				if (val === undefined) {
					return config.RATE_LIMIT;
				}
				return val;
			}, z.coerce.number().optional())
			.optional(), // how many messages per minute
	})
	.optional();

export const usageLimits = usageLimitsSchema.parse(
	JSON5.parse(sanitizeJSONEnv(config.USAGE_LIMITS, "{}"))
);

/**
 * How many stored conversations this account may hold: the deployment's USAGE_LIMITS.conversations, or
 * the staff tier's for a team account (teamAccount.ts, CUR-4620), never below the deployment's own.
 * Undefined means no cap. `limit` is a parameter so the spec can pass one without an env.
 */
export function conversationLimitFor(
	user: { email?: string; emailVerified?: boolean } | null | undefined,
	limit: number | undefined = usageLimits?.conversations
): number | undefined {
	if (!limit) return undefined;
	return isTeamAccount(user) ? Math.max(limit, STAFF_TIER.conversations) : limit;
}
