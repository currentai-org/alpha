// Operator override panel — lets reviewers/editors edit Gap Chat prompts + decoding params +
// starter prompts via /tuning WITHOUT a deploy. Stored as a single "TUNING" row in the
// EXISTING `config` table (no new schema). Every field is optional; read sites use
// `override ?? code-default`, so a missing/invalid row — or deleting the whole panel —
// reverts to the hardcoded behavior.
//
// Long-term disposition undecided (CUR-893): treat this as live infrastructure, not a stopgap.
// It's a second source of behavior that isn't code (no git history, no diff), and an override
// row can make a deployment drift from the code (CUR-620) — run
// scripts/check-tuning-overrides.sh before assuming a code/behavior mismatch is a code bug.
// The row also carries a `history` array of prior persona/grounding versions (the version
// backup) — if the panel is ever removed, drop that too: stale admin-authored prompt/safety-
// logic versions sitting at rest are extra attack surface if the DB is breached, for zero value  // vocab-ok:security
// once the panel is gone.
import { z } from "zod";
import { collections } from "$lib/chat/server/database";
import { logger } from "$lib/chat/server/logger";

const DecodingSchema = z
	.object({
		temperature: z.number().min(0).max(2),
		frequency_penalty: z.number().min(-2).max(2),
		presence_penalty: z.number().min(-2).max(2),
		max_tokens: z.number().int().min(1).max(4096),
	})
	.partial();

// How many prior versions to keep in the in-doc backup. Each save snapshots the value it
// replaces, so an accidental overwrite / "reset to default" / bad edit is recoverable in-panel
// (the tuning row otherwise lives ONLY in the DB with no history). Personas are a few KB in
// practice, so 20 keeps the config row comfortably bounded.
const HISTORY_LIMIT = 20;

// A single saved version: the editable fields + who/when. No `history` field — snapshots never nest.
const SnapshotSchema = z
	.object({
		persona: z.string().max(20000),
		grounding: z.string().max(20000),
		decoding: DecodingSchema,
		starters: z.array(z.string().min(1).max(2000)).max(8),
		// Collective second opinion (panel fanout + verdict) prompts + the web-search-decision
		// classifier prompt. Optional; read sites use `override || code-default`.
		panelistPrompt: z.string().max(20000),
		aggregatorPrompt: z.string().max(20000),
		searchClassifierPrompt: z.string().max(20000),
		editedBy: z.string().max(200),
		editedAt: z.string().max(40),
	})
	.partial();

export type TuningSnapshot = z.infer<typeof SnapshotSchema>;

// All optional: absence of a field = use the code default at the read site. `history` is the
// version backup (prior values, newest first), maintained server-side by setTuning — the form
// never submits it.
export const TuningSchema = SnapshotSchema.extend({
	history: z.array(SnapshotSchema).max(HISTORY_LIMIT),
}).partial();

export type Tuning = z.infer<typeof TuningSchema>;

const KEY = "TUNING";
const TTL_MS = 20_000;
let cache: { at: number; value: Tuning } | null = null;

/** Parse a raw stored doc into Tuning; invalid input fails safe to {} (→ code defaults).
 *  Unknown keys (e.g. the row's `key`) are stripped by the schema. Pure; unit-tested. */
export function parseTuning(raw: unknown): Tuning {
	const parsed = TuningSchema.safeParse(raw ?? {});
	return parsed.success ? parsed.data : {};
}

// The config collection is typed to ConfigKey (env keys); TUNING is our own row, so a
// narrow structural cast is used for read/write. Kept local to this module.
type ConfigRowStore = {
	findOne(filter: { key: string }): Promise<Record<string, unknown> | null>;
	updateOne(
		filter: { key: string; editedAt?: string },
		update: { $set: Record<string, unknown> },
		opts: { upsert: boolean }
	): Promise<{ matchedCount: number }>;
	deleteOne(filter: { key: string }): Promise<{ deletedCount: number }>;
};
function configStore(): ConfigRowStore {
	return collections.config as unknown as ConfigRowStore;
}

/** Thrown by setTuning when the stored row changed since the editor loaded it (optimistic-
 *  concurrency miss). Carries who/when of the conflicting save so the UI can tell the editor
 *  to reload before overwriting. Distinct from a validation Error so the route can branch. */
export class TuningConflictError extends Error {
	constructor(
		readonly editedBy?: string,
		readonly editedAt?: string
	) {
		super("Tuning was changed by someone else since you loaded the panel");
		this.name = "TuningConflictError";
	}
}

/** Current tuning overrides (cached ~20s). Fails safe to {} on any read/parse error so a
 *  broken row can never take down the chat. */
export async function getTuning(): Promise<Tuning> {
	if (cache && Date.now() - cache.at < TTL_MS) {
		return cache.value;
	}
	let value: Tuning = {};
	try {
		const row = await configStore().findOne({ key: KEY });
		value = parseTuning(row);
	} catch (e) {
		logger.warn(e, "[tuning] read failed; using code defaults");
	}
	cache = { at: Date.now(), value };
	return value;
}

/** REPLACE the stored doc with a validated `next` (the admin form submits the full desired
 *  state, so an omitted field means "use the code default" — replace, not merge). Stamps
 *  editor + time, upserts, busts cache. THROWS on invalid input — writes must NOT fail-safe
 *  to {} (that would silently wipe every existing override); only reads do.
 *
 *  Optimistic concurrency: `expectedEditedAt` is the editedAt the editor loaded. The write only
 *  lands if the stored row STILL has that editedAt — otherwise a concurrent editor saved in
 *  between and this would clobber them (the panel does a full-document replace, so even an edit to
 *  a different field would overwrite the other's), so we throw TuningConflictError instead. Pass
 *  undefined only when the editor loaded with NO row yet (first-ever save). */
export async function setTuning(
	next: Tuning,
	editedBy: string,
	expectedEditedAt?: string
): Promise<Tuning> {
	const store = configStore();

	// Version backup: snapshot the value THIS save replaces (newest-first), capped at HISTORY_LIMIT,
	// so an overwrite/reset/bad-edit is recoverable. Read the current stored value + its history.
	const prior = parseTuning(await store.findOne({ key: KEY }));
	const { history: priorHistory = [], ...priorValue } = prior;
	// Only snapshot a REAL prior save (editedAt present) — not the empty "no row yet" state.
	const history = (priorValue.editedAt ? [priorValue, ...priorHistory] : priorHistory).slice(
		0,
		HISTORY_LIMIT
	);

	const parsed = TuningSchema.safeParse({
		...next,
		editedBy,
		editedAt: new Date().toISOString(),
		history,
	});
	if (!parsed.success) {
		throw new Error(
			parsed.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ")
		);
	}

	if (expectedEditedAt) {
		// Conditional update: matches only while the row's editedAt is unchanged. matchedCount 0 →
		// the row changed or vanished since load → conflict. No upsert (the row must already exist).
		const res = await store.updateOne(
			{ key: KEY, editedAt: expectedEditedAt },
			{ $set: parsed.data },
			{ upsert: false }
		);
		if (res.matchedCount === 0) {
			const current = parseTuning(await store.findOne({ key: KEY }));
			throw new TuningConflictError(current.editedBy, current.editedAt);
		}
	} else {
		// Editor loaded with no existing row. Insert-if-absent: if a row appeared since (someone
		// created the tuning while they edited from defaults), that's a conflict too. Reuses the
		// `prior` read above — small read-then-write window, acceptable for the once-ever first save.
		if (priorValue.editedAt) {
			throw new TuningConflictError(priorValue.editedBy, priorValue.editedAt);
		}
		await store.updateOne({ key: KEY }, { $set: parsed.data }, { upsert: true });
	}

	cache = { at: Date.now(), value: parsed.data };
	return parsed.data;
}

/** Delete the whole TUNING row → every read site reverts to its code default. The admin "reset to
 *  defaults": wipes overrides AND the version history — a deliberate clean slate, distinct from a
 *  blank Save (which keeps history). Busts the cache so the revert is visible within the TTL. */
export async function clearTuning(): Promise<void> {
	await configStore().deleteOne({ key: KEY });
	cache = { at: Date.now(), value: {} };
}

export function bustTuningCache(): void {
	cache = null;
}
