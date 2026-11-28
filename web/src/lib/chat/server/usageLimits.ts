// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { z } from "zod";
import { config } from "$lib/chat/server/config";
import JSON5 from "json5";
import { sanitizeJSONEnv } from "$lib/chat/server/envParse";
import { STAFF_TIER, isTeamAccount } from "$lib/chat/server/teamAccount";

/** Messages a minute per session when neither USAGE_LIMITS.messagesPerMinute nor RATE_LIMIT sets one. */
export const DEFAULT_MESSAGES_PER_MINUTE = 20;

/**
 * The per-session limit RATE_LIMIT gives. Unset or blank is the default, never "no limit". RATE_LIMIT=0
 * still turns the limit off on purpose.
 */
export function messagesPerMinuteFrom(rateLimit: string | undefined): number {
	const raw = rateLimit?.trim();
	return raw ? Number(raw) : DEFAULT_MESSAGES_PER_MINUTE;
}

const usageLimitsSchema = z
	.object({
		conversations: z.coerce.number().optional(), // how many conversations
		messages: z.coerce.number().optional(), // how many messages in a conversation
		messageLength: z.coerce.number().optional(), // how long can a message be before we cut it off
		messagesPerMinute: z.coerce.number().optional(), // how many messages per minute
	})
	.optional();

const parsedUsageLimits = usageLimitsSchema.parse(JSON5.parse(sanitizeJSONEnv(config.USAGE_LIMITS, "{}")));

// RATE_LIMIT is the older way to set messagesPerMinute, and USAGE_LIMITS wins when it names one. The
// fallback is applied after the parse: as a z.preprocess on the field it never ran, because zod skips a
// missing key, so RATE_LIMIT was read by nothing and a deployment without USAGE_LIMITS.messagesPerMinute
// had neither the per-session limit nor the per-IP ceiling built on it.
export const usageLimits = {
	...parsedUsageLimits,
	messagesPerMinute: parsedUsageLimits?.messagesPerMinute ?? messagesPerMinuteFrom(config.RATE_LIMIT),
};

/**
 * How many stored conversations this account may hold: the deployment's USAGE_LIMITS.conversations, or
 * the staff tier's for a team account (teamAccount.ts), never below the deployment's own.
 * Undefined means no cap. `limit` is a parameter so the spec can pass one without an env.
 */
export function conversationLimitFor(
	user: { email?: string; emailVerified?: boolean } | null | undefined,
	limit: number | undefined = usageLimits?.conversations
): number | undefined {
	if (!limit) return undefined;
	return isTeamAccount(user) ? Math.max(limit, STAFF_TIER.conversations) : limit;
}
