/**
 * Contribution write point — the single place "Get involved" submissions are persisted,
 * mirroring the Vercel app's `saveContribution` (chat/lib/db/queries.ts). The public welcome
 * overlay's ContributeDialog posts here via /api/contribute.
 *
 * Adds a DB-backed per-IP daily cap primitive (countContributionsByIpSince) because this app
 * has no Redis — the Vercel app caps per IP via Redis (lib/ratelimit.ts checkContributionRateLimit).
 */
import { and, count, eq, gte } from "drizzle-orm";
import { getDb } from "./client";
import { newId } from "./ids";
import { hashIp } from "./ipHash";
import { contributions, type ContributionRow } from "./schema";

export interface SaveContributionInput {
	kind: "subscribe" | "contribute" | "data_interest" | "model_suggestion";
	/** Required for subscribe/contribute; optional for data_interest and model_suggestion. */
	email?: string | null;
	name?: string | null;
	organization?: string | null;
	contributionType?: "compute" | "data" | "code" | "funding" | "other" | null;
	detail?: string | null;
	/** Routing language tag, for data_interest and model_suggestion. */
	language?: string | null;
	userId?: string | null;
	// Raw client IP at the boundary; hashed (HMAC, see ipHash.ts) before it ever touches the DB.
	ip?: string | null;
}

export async function saveContribution(input: SaveContributionInput): Promise<ContributionRow> {
	const db = getDb();
	const [row] = await db
		.insert(contributions)
		.values({
			id: newId(),
			kind: input.kind,
			email: input.email ?? null,
			name: input.name ?? null,
			organization: input.organization ?? null,
			contributionType: input.contributionType ?? null,
			detail: input.detail ?? null,
			language: input.language ?? null,
			userId: input.userId ?? null,
			// Store only the keyed hash — never the raw IP (see ipHash.ts). null when no pepper.
			ipHash: hashIp(input.ip),
		})
		.returning();
	return row;
}

/**
 * DB-backed per-IP daily cap primitive (mirrors the messageEvents countDocuments pattern).
 * Counts by the SAME keyed hash used on write, so the raw IP never has to be stored to match.
 * Returns 0 when the IP can't be hashed (no pepper / empty) — i.e. the cap fails OPEN, by design.
 */
export async function countContributionsByIpSince(ip: string, since: Date): Promise<number> {
	const h = hashIp(ip);
	if (!h) return 0;
	const db = getDb();
	const [row] = await db
		.select({ value: count() })
		.from(contributions)
		.where(and(eq(contributions.ipHash, h), gte(contributions.createdAt, since)));
	return row?.value ?? 0;
}
