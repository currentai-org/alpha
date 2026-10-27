/**
 * The CLI's one-click pairing handoff (CUR-4110, schema.ts's `local_inference_pairings`).
 *
 * Three steps, each one atomic statement so concurrent requests cannot double-provision or
 * double-collect:
 *   1. claimPairing      — the signed-in visit to the pairing link takes the id (INSERT ... ON CONFLICT
 *                          DO NOTHING). Only the visit that inserted goes on to provision.
 *   2. completePairing   — that visit parks the provisioned endpoint's install flags on the row.
 *   3. collectPairing    — the CLI's poll takes them and nulls them in one UPDATE ... RETURNING, so
 *                          two polls racing get the credentials once between them.
 *
 * The pairing id never reaches the database: rows are keyed on its SHA-256 (see the schema comment).
 */
import { createHash } from "crypto";
import { and, asc, eq, isNotNull, isNull, gt, lt } from "drizzle-orm";
import { getDb } from "./client";
import {
	localInferenceEndpoints,
	localInferencePairings,
	type LocalInferencePairingCredentials,
	type ManagedEndpointConfig,
} from "./schema";

export type { LocalInferencePairingCredentials };

/** How long a claimed pairing waits for the CLI to collect it, and how long its tombstone then blocks
 *  a second visit to the same link. The CLI is polling while the person clicks, so minutes is ample. */
const PAIRING_TTL_MS = 10 * 60 * 1000;

/** What the CLI must generate: 32 to 128 URL-safe characters. 32 base64url characters carry 192 bits,
 *  which is what makes an unauthenticated poll keyed on nothing else safe to expose. */
const PAIRING_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function isValidPairingId(id: string): boolean {
	return PAIRING_ID_PATTERN.test(id);
}

function hashPairingId(pairingId: string): string {
	return createHash("sha256").update(pairingId).digest("hex");
}

export type ClaimResult =
	/** This visit took the id and must now provision, then call completePairing (or releasePairing). */
	| { status: "claimed" }
	/** The same person already took this id: an earlier visit, a reload, or one still provisioning. */
	| { status: "already-claimed"; completed: boolean }
	/** Someone else's account holds this id. Nothing about their pairing is disclosed. */
	| { status: "taken" };

export async function claimPairing(
	userId: string,
	pairingId: string,
	now: Date = new Date()
): Promise<ClaimResult> {
	const db = getDb();
	const pairingIdHash = hashPairingId(pairingId);

	// An expired row is free to reclaim: its CLI stopped polling long ago. Clearing it first, scoped to
	// this one id, keeps the claim itself a plain insert.
	await db
		.delete(localInferencePairings)
		.where(and(eq(localInferencePairings.pairingIdHash, pairingIdHash), lt(localInferencePairings.expiresAt, now)));

	const inserted = await db
		.insert(localInferencePairings)
		.values({ pairingIdHash, userId, expiresAt: new Date(now.getTime() + PAIRING_TTL_MS) })
		.onConflictDoNothing()
		.returning({ pairingIdHash: localInferencePairings.pairingIdHash });
	if (inserted.length > 0) return { status: "claimed" };

	const [existing] = await db
		.select({
			userId: localInferencePairings.userId,
			endpointId: localInferencePairings.endpointId,
		})
		.from(localInferencePairings)
		.where(eq(localInferencePairings.pairingIdHash, pairingIdHash))
		.limit(1);
	// Gone between the insert and this read (swept, or its endpoint deleted): treat as someone else's
	// rather than retrying, so a visit never loops.
	if (!existing || existing.userId !== userId) return { status: "taken" };
	return { status: "already-claimed", completed: existing.endpointId !== null };
}

/** Where this person stands with a pairing id, read-only: never claims it. The pairing page asks this
 *  before deciding whether an arrival needs a confirm click, because the page's own data reloads
 *  (hydration, an invalidation, Back) arrive same-origin and must keep showing a finished pairing. */
export async function pairingStatusFor(
	userId: string,
	pairingId: string,
	now: Date = new Date()
): Promise<"unclaimed" | "pending" | "completed" | "taken"> {
	const [row] = await getDb()
		.select({ userId: localInferencePairings.userId, endpointId: localInferencePairings.endpointId })
		.from(localInferencePairings)
		.where(
			and(eq(localInferencePairings.pairingIdHash, hashPairingId(pairingId)), gt(localInferencePairings.expiresAt, now))
		)
		.limit(1);
	if (!row) return "unclaimed";
	if (row.userId !== userId) return "taken";
	return row.endpointId === null ? "pending" : "completed";
}

/** Parks the provisioned endpoint's install flags for the CLI. Scoped to the claiming user. */
export async function completePairing(
	userId: string,
	pairingId: string,
	credentials: LocalInferencePairingCredentials
): Promise<void> {
	await getDb()
		.update(localInferencePairings)
		.set({ endpointId: credentials.endpointId, credentials })
		.where(
			and(
				eq(localInferencePairings.pairingIdHash, hashPairingId(pairingId)),
				eq(localInferencePairings.userId, userId)
			)
		);
}

/** Gives the id back after a failed provision, so the person can retry the same link. Only an
 *  uncompleted claim is released: a completed one belongs to a device that may already be collecting. */
export async function releasePairing(userId: string, pairingId: string): Promise<void> {
	await getDb()
		.delete(localInferencePairings)
		.where(
			and(
				eq(localInferencePairings.pairingIdHash, hashPairingId(pairingId)),
				eq(localInferencePairings.userId, userId),
				isNull(localInferencePairings.endpointId)
			)
		);
}

/** The CLI's poll: the parked credentials exactly once, then null forever. Null as well before the
 *  visit, while it provisions, after expiry, and for an id nobody claimed — the poll cannot tell those
 *  apart, and neither can anyone guessing ids. */
export async function collectPairing(
	pairingId: string,
	now: Date = new Date()
): Promise<LocalInferencePairingCredentials | null> {
	const pairingIdHash = hashPairingId(pairingId);
	// RETURNING reports the row as updated, so it cannot read back a column the same UPDATE clears.
	// The row lock does the exactly-once part instead: a second poll blocks on FOR UPDATE until this
	// transaction commits, then re-checks `credentials IS NOT NULL` against the cleared row and matches
	// nothing.
	return getDb().transaction(async (tx) => {
		const [row] = await tx
			.select({ credentials: localInferencePairings.credentials })
			.from(localInferencePairings)
			.where(
				and(
					eq(localInferencePairings.pairingIdHash, pairingIdHash),
					isNotNull(localInferencePairings.credentials),
					gt(localInferencePairings.expiresAt, now)
				)
			)
			.for("update");
		if (!row?.credentials) return null;
		await tx
			.update(localInferencePairings)
			.set({ credentials: null, consumedAt: now })
			.where(eq(localInferencePairings.pairingIdHash, pairingIdHash));
		return row.credentials;
	});
}

/** Expired pairings whose credentials were never collected, with the endpoint each one provisioned:
 *  the person approved in the browser, but no device ever received the credentials, so the endpoint
 *  can never come online. Oldest first, at most `limit`. A collected pairing never appears here: its
 *  endpoint belongs to a working device. Read by sweepUncollectedPairings.ts, which revokes and
 *  deletes each endpoint (the pairing goes with it, by cascade). */
export async function listUncollectedExpiredPairings(
	limit: number,
	now: Date = new Date()
): Promise<{ userId: string; endpointId: string; managedConfig: ManagedEndpointConfig | null }[]> {
	return getDb()
		.select({
			userId: localInferencePairings.userId,
			endpointId: localInferenceEndpoints.id,
			managedConfig: localInferenceEndpoints.managedConfig,
		})
		.from(localInferencePairings)
		.innerJoin(localInferenceEndpoints, eq(localInferenceEndpoints.id, localInferencePairings.endpointId))
		.where(and(lt(localInferencePairings.expiresAt, now), isNull(localInferencePairings.consumedAt)))
		.orderBy(asc(localInferencePairings.expiresAt))
		.limit(limit);
}
