/**
 * Which rows a wipe reaches, written once. `wipeUserData` deletes by these conditions and
 * `previewWipe` counts by them, so the confirm panel's list and the receipt cannot drift apart.
 * Every condition is keyed by the caller's own sessionId/userId and never by IP; see the
 * header of wipeUserData.ts for why.
 */
import { and, count, eq, inArray, ne, or, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getDb } from "./client";
import { countCustodialFilesForWipe } from "$lib/chat/server/storage/custodialStorage";
import { agentServiceToken, agentServiceUrl } from "$lib/chat/server/agentMode";
import { logger } from "$lib/chat/server/logger";
import * as schema from "./schema";
import type { WipePreview } from "$lib/chat/types/WipeSummary";

export interface WipeScopeKeys {
	sessionId?: string;
	userId?: string;
}

/** OR the present conditions; undefined when none apply (so we never build an empty/match-all WHERE). */
export function any(conds: (SQL | undefined)[]): SQL | undefined {
	const present = conds.filter((c): c is SQL => c !== undefined);
	if (present.length === 0) return undefined;
	return present.length === 1 ? present[0] : or(...present);
}

/** The WHERE for each table whose rows a wipe deletes by the caller's identity. undefined = no scope, nothing to delete. */
export function wipeScope(keys: WipeScopeKeys) {
	const sid = keys.sessionId;
	const uid = keys.userId;
	// The identifiers message_events/contributions stamp as `userId` for this caller.
	const ownIds = [uid, sid].filter((v): v is string => !!v);
	const safetyWhere = any([
		ownIds.length > 0 ? inArray(schema.safetyEvents.userId, ownIds) : undefined,
		sid ? eq(schema.safetyEvents.sessionId, sid) : undefined,
	]);
	return {
		conversations: any([
			sid ? eq(schema.conversations.sessionId, sid) : undefined,
			uid ? eq(schema.conversations.userId, uid) : undefined,
		]),
		settings: any([
			sid ? eq(schema.settings.sessionId, sid) : undefined,
			uid ? eq(schema.settings.userId, uid) : undefined,
		]),
		messageEvents: ownIds.length > 0 ? inArray(schema.messageEvents.userId, ownIds) : undefined,
		contributions: ownIds.length > 0 ? inArray(schema.contributions.userId, ownIds) : undefined,
		// Every decline record except child-safety ones, which are retained under Art. 17(3).
		safetyEvents: safetyWhere ? and(safetyWhere, ne(schema.safetyEvents.kind, "child_safety")) : undefined,
		localInferenceEndpoints: uid ? eq(schema.localInferenceEndpoints.userId, uid) : undefined,
		storageLocations: uid ? eq(schema.storageLocations.userId, uid) : undefined,
		shareLinks: uid ? eq(schema.sharedConversations.userId, uid) : undefined,
		tags: uid ? eq(schema.conversationTags.userId, uid) : undefined,
		humanEvalRatings: uid ? eq(schema.humanEvalRatings.userId, uid) : undefined,
		humanEvalProfiles: uid ? eq(schema.humanEvalProfiles.userId, uid) : undefined,
	};
}

export type { WipePreview };

async function countWhere(table: PgTable, where: SQL | undefined): Promise<number> {
	if (!where) return 0;
	const [row] = await getDb().select({ n: count() }).from(table).where(where);
	return Number(row?.n ?? 0);
}

/**
 * Read-only counts for the buckets the receipt lists. Database rows are counted by the conditions the
 * wipe deletes by. Uploaded files are counted from the storage listing the wipe deletes from. Agent
 * tasks live in agent-service's own store with no count to read, so only whether this deployment keeps
 * any is reported. Counts only the caller's own rows.
 */
export async function previewWipe(keys: WipeScopeKeys & { deleteAccount?: boolean }): Promise<WipePreview> {
	const w = wipeScope(keys);
	const [
		conversations,
		settings,
		messageEvents,
		contributions,
		localInferenceEndpoints,
		storageLocations,
		safetyEvents,
	] = await Promise.all([
		countWhere(schema.conversations, w.conversations),
		countWhere(schema.settings, w.settings),
		countWhere(schema.messageEvents, w.messageEvents),
		countWhere(schema.contributions, w.contributions),
		countWhere(schema.localInferenceEndpoints, w.localInferenceEndpoints),
		countWhere(schema.storageLocations, w.storageLocations),
		countWhere(schema.safetyEvents, w.safetyEvents),
	]);
	let custodialFiles: number | undefined;
	if (keys.userId) {
		try {
			custodialFiles = await countCustodialFilesForWipe(keys.userId);
		} catch (e) {
			// A failed listing leaves the line off rather than claiming zero; the confirm copy still says files go.
			logger.warn({ err: e }, "[wipe-preview] could not list uploaded files");
		}
	}
	const accountDeleted =
		keys.deleteAccount === true && !!keys.userId && (await countWhere(schema.users, eq(schema.users.id, keys.userId))) > 0;
	return {
		conversations,
		settings,
		messageEvents,
		contributions,
		localInferenceEndpoints,
		storageLocations,
		safetyEvents,
		accountDeleted,
		custodialFiles,
		agentHistoryPossible: !!agentServiceUrl() && !!agentServiceToken(),
	};
}
