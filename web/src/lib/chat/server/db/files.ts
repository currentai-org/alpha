/**
 * File store — the Postgres `files` table. Attachments are small
 * (size-capped upstream — see $lib/chat/constants/uploadLimits) so a bytea payload row is sufficient and keeps everything on Neon with no
 * extra credentials. (Vercel Blob is a viable later optimization for larger payloads.)
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./client";
import { newId } from "./ids";
import { files, type FileRow } from "./schema";

export async function putFile(input: {
	filename: string;
	conversationId: string;
	mime?: string;
	data: Buffer;
}): Promise<void> {
	const db = getDb();
	await db
		.insert(files)
		.values({
			id: newId(),
			filename: input.filename,
			conversationId: input.conversationId,
			mime: input.mime,
			data: input.data,
		})
		.onConflictDoNothing();
}

export async function getFileByFilename(
	filename: string,
	conversationId: string
): Promise<FileRow | undefined> {
	const db = getDb();
	const [row] = await db
		.select()
		.from(files)
		.where(and(eq(files.filename, filename), eq(files.conversationId, conversationId)))
		.limit(1);
	return row;
}

/**
 * A file row belonging to NO conversation, by name.
 *
 * Deliberately NARROWER than getFileByFilename above rather than looser: `conversation_id is null`
 * is part of the query, so this cannot return somebody's conversation attachment however the caller
 * spells the filename. That predicate is the access check, not a filter applied afterwards.
 *
 * Deployment walkthrough recordings are stored this way (CUR-1524) — they are evidence about a
 * deployment rather than about a conversation, and nothing else writes a conversation-less file row.
 */
export async function getUnscopedFileByFilename(filename: string): Promise<FileRow | undefined> {
	const db = getDb();
	const [row] = await db
		.select()
		.from(files)
		.where(and(eq(files.filename, filename), isNull(files.conversationId)))
		.limit(1);
	return row;
}
