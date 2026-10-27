/**
 * The MCP servers a person added in Settings → Connectors (schema.ts's `user_mcp_servers`).
 * Plain drizzle, same shape as storageLocations.ts.
 *
 * Every read and delete scopes by `userId` in the query itself, never by id alone: the id space is
 * opaque but not secret, and this check is what keeps one account off another's server and token. (CUR-4016)
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "./client";
import { userMcpServers, type UserMcpServerRow } from "./schema";
import { newId } from "./ids";

export type { UserMcpServerRow };

export async function listUserMcpServers(userId: string): Promise<UserMcpServerRow[]> {
	return getDb()
		.select()
		.from(userMcpServers)
		.where(eq(userMcpServers.userId, userId))
		.orderBy(userMcpServers.createdAt);
}

export async function createUserMcpServer(input: {
	userId: string;
	name: string;
	url: string;
	credential: string | null;
}): Promise<UserMcpServerRow> {
	const [row] = await getDb()
		.insert(userMcpServers)
		.values({ ...input, id: newId() })
		.returning();
	return row;
}

/** Deletes one of the person's servers. Returns whether a row of theirs was removed. */
export async function deleteUserMcpServer(userId: string, id: string): Promise<boolean> {
	const rows = await getDb()
		.delete(userMcpServers)
		.where(and(eq(userMcpServers.userId, userId), eq(userMcpServers.id, id)))
		.returning({ id: userMcpServers.id });
	return rows.length > 0;
}
