// Reads and writes for human evaluation (A2, CUR-1914). The rules live in humanEval/; this file only
// moves rows.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "./client";
import { newId } from "./ids";
import {
	humanEvalProfiles,
	humanEvalRatings,
	humanEvalRuns,
	type HumanEvalProfileRow,
	type HumanEvalRunRow,
	type NewHumanEvalRatingRow,
} from "./schema";
import type { DeclaredLevel, RatingRow } from "../humanEval/types";

export const DAILY_RATING_CAP = 60;

export async function getProfile(userId: string, language: string): Promise<HumanEvalProfileRow | null> {
	const [row] = await getDb()
		.select()
		.from(humanEvalProfiles)
		.where(and(eq(humanEvalProfiles.userId, userId), eq(humanEvalProfiles.language, language)));
	return row ?? null;
}

export async function upsertProfile(input: {
	userId: string;
	language: string;
	level: DeclaredLevel;
	variety?: string | null;
	consentVersion: string;
}): Promise<HumanEvalProfileRow> {
	const [row] = await getDb()
		.insert(humanEvalProfiles)
		.values({ id: newId(), ...input, variety: input.variety ?? null })
		.onConflictDoUpdate({
			target: [humanEvalProfiles.userId, humanEvalProfiles.language],
			set: { level: input.level, variety: input.variety ?? null, consentVersion: input.consentVersion, consentedAt: new Date() },
		})
		.returning();
	return row;
}

export async function markCalibrationSeen(profileId: string): Promise<void> {
	await getDb().update(humanEvalProfiles).set({ calibrationSeenAt: new Date() }).where(eq(humanEvalProfiles.id, profileId));
}

export async function incrementFailedChecks(profileId: string): Promise<void> {
	await getDb()
		.update(humanEvalProfiles)
		.set({ failedChecks: sql`${humanEvalProfiles.failedChecks} + 1` })
		.where(eq(humanEvalProfiles.id, profileId));
}

/** Current runs in a language with how many valid ratings each has. */
export async function candidatesFor(language: string, taskSetVersion: string) {
	const db = getDb();
	return db
		.select({
			runId: humanEvalRuns.id,
			modelId: humanEvalRuns.modelId,
			taskId: humanEvalRuns.taskId,
			isCheck: humanEvalRuns.isCheck,
			validRatings: sql<number>`count(${humanEvalRatings.id}) filter (where ${humanEvalRatings.validity} = 'valid')`.mapWith(Number),
		})
		.from(humanEvalRuns)
		.leftJoin(humanEvalRatings, eq(humanEvalRatings.runId, humanEvalRuns.id))
		.where(
			and(
				eq(humanEvalRuns.language, language),
				eq(humanEvalRuns.current, true),
				eq(humanEvalRuns.taskSetVersion, taskSetVersion)
			)
		)
		.groupBy(humanEvalRuns.id);
}

/** The languages with at least one current, non-check stored answer for this task set. */
export async function languagesWithAnswers(taskSetVersion: string): Promise<Set<string>> {
	const rows = await getDb()
		.selectDistinct({ language: humanEvalRuns.language })
		.from(humanEvalRuns)
		.where(
			and(
				eq(humanEvalRuns.current, true),
				eq(humanEvalRuns.taskSetVersion, taskSetVersion),
				eq(humanEvalRuns.isCheck, false)
			)
		);
	return new Set(rows.map((r) => r.language));
}

export async function getRun(runId: string): Promise<HumanEvalRunRow | null> {
	const [row] = await getDb().select().from(humanEvalRuns).where(eq(humanEvalRuns.id, runId));
	return row ?? null;
}

/** This person's ratings in a language, newest first. */
export async function ratingsByUser(userId: string, language: string) {
	return getDb()
		.select({
			runId: humanEvalRatings.runId,
			taskId: humanEvalRatings.taskId,
			scores: humanEvalRatings.scores,
			createdAt: humanEvalRatings.createdAt,
		})
		.from(humanEvalRatings)
		.where(and(eq(humanEvalRatings.userId, userId), eq(humanEvalRatings.language, language)))
		.orderBy(desc(humanEvalRatings.createdAt));
}

export async function countRatingsSince(userId: string, since: Date): Promise<number> {
	const [row] = await getDb()
		.select({ n: sql<number>`count(*)`.mapWith(Number) })
		.from(humanEvalRatings)
		.where(and(eq(humanEvalRatings.userId, userId), gte(humanEvalRatings.createdAt, since)));
	return row?.n ?? 0;
}

/**
 * Inserts one rating. Returns null when this person already rated this answer: the unique index is
 * the refusal, so two tabs submitting at once cannot both land.
 */
export async function insertRating(row: Omit<NewHumanEvalRatingRow, "id">): Promise<string | null> {
	const id = newId();
	const inserted = await getDb()
		.insert(humanEvalRatings)
		.values({ id, ...row })
		.onConflictDoNothing({ target: [humanEvalRatings.userId, humanEvalRatings.runId] })
		.returning({ id: humanEvalRatings.id });
	return inserted[0]?.id ?? null;
}

/**
 * Marks every counted rating by this person in this language as quarantined. Used once they have
 * failed more check items than quality.ts allows, so the ratings they gave before the second
 * failure stop counting too.
 */
export async function quarantineRatings(userId: string, language: string, reason: string): Promise<number> {
	const rows = await getDb()
		.update(humanEvalRatings)
		.set({
			validity: "quarantined",
			reasons: sql`${humanEvalRatings.reasons} || ${JSON.stringify([reason])}::jsonb`,
		})
		.where(
			and(
				eq(humanEvalRatings.userId, userId),
				eq(humanEvalRatings.language, language),
				eq(humanEvalRatings.validity, "valid")
			)
		)
		.returning({ id: humanEvalRatings.id });
	return rows.length;
}

/**
 * Ratings in a language on the answers raters are currently shown, in the shape aggregate.ts reads.
 * Ratings on replaced answers (an older model revision or app build) are left out, so a result never
 * mixes two versions of a model.
 */
export async function ratingRowsFor(language: string): Promise<RatingRow[]> {
	const r = humanEvalRatings;
	return getDb()
		.select({
			raterId: r.userId,
			modelRunId: r.runId,
			modelId: r.modelId,
			language: r.language,
			taskId: r.taskId,
			declaredLevel: r.declaredLevel,
			rubricVersion: r.rubricVersion,
			taskSetVersion: r.taskSetVersion,
			scores: r.scores,
			validity: r.validity,
		})
		.from(r)
		.innerJoin(humanEvalRuns, eq(humanEvalRuns.id, r.runId))
		.where(and(eq(r.language, language), eq(humanEvalRuns.current, true)));
}

/**
 * What the data export includes for one person: their language profiles and their ratings with the
 * request and answer they rated. The model id and whether each rating counted are left out, the first
 * so the export does not unmask answers they may rate again, the second so the checks cannot be
 * learned (the same reason submitRating answers the same either way).
 */
export async function humanEvalExport(userId: string) {
	const db = getDb();
	const p = humanEvalProfiles;
	const r = humanEvalRatings;
	const [profiles, ratings] = await Promise.all([
		db
			.select({
				language: p.language,
				level: p.level,
				variety: p.variety,
				consentVersion: p.consentVersion,
				consentedAt: p.consentedAt,
			})
			.from(p)
			.where(eq(p.userId, userId)),
		db
			.select({
				language: r.language,
				taskId: r.taskId,
				request: humanEvalRuns.prompt,
				answer: humanEvalRuns.response,
				scores: r.scores,
				flags: r.flags,
				comment: r.comment,
				durationMs: r.durationMs,
				createdAt: r.createdAt,
			})
			.from(r)
			.innerJoin(humanEvalRuns, eq(humanEvalRuns.id, r.runId))
			.where(eq(r.userId, userId))
			.orderBy(r.createdAt),
	]);
	return { profiles, ratings };
}
