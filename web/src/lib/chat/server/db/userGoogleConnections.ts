/**
 * A person's connected Google account (schema.ts's `user_google_connections`), at most one each.
 * Plain drizzle, same shape as userMcpServers.ts. Every read and delete is keyed by `userId` in the
 * query itself, so one account never reads another's token.
 */
import { eq } from "drizzle-orm";
import { getDb } from "./client";
import { userGoogleConnections, type UserGoogleConnectionRow } from "./schema";

export type { UserGoogleConnectionRow };

export async function getUserGoogleConnection(userId: string): Promise<UserGoogleConnectionRow | null> {
	const [row] = await getDb()
		.select()
		.from(userGoogleConnections)
		.where(eq(userGoogleConnections.userId, userId))
		.limit(1);
	return row ?? null;
}

/** Stores the connection, replacing an earlier one: connecting again is how a person switches account. */
export async function saveUserGoogleConnection(input: {
	userId: string;
	email: string;
	scopes: string;
	credential: string;
}): Promise<void> {
	await getDb()
		.insert(userGoogleConnections)
		.values(input)
		.onConflictDoUpdate({
			target: userGoogleConnections.userId,
			set: { email: input.email, scopes: input.scopes, credential: input.credential, createdAt: new Date() },
		});
}

/** Removes the person's connection. Returns whether there was one. */
export async function deleteUserGoogleConnection(userId: string): Promise<boolean> {
	const rows = await getDb()
		.delete(userGoogleConnections)
		.where(eq(userGoogleConnections.userId, userId))
		.returning({ userId: userGoogleConnections.userId });
	return rows.length > 0;
}
