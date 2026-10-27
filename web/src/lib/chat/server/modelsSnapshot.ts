// Pure, testable helpers for the model-catalog boot snapshot (TTFT plan §C).
//
// These are the side-effect-free pieces of models.ts's snapshot boot: the shared catalog-entry schema,
// the snapshot envelope validation, and the id-set drift comparison. They live here (separate from
// models.ts, which network-fetches the catalog at module load) so they can be unit-tested without
// booting the live registry — the same reason modelsCatalog.ts's transforms live outside models.ts.

import { z } from "zod";

// The upstream OpenAI-compatible /models catalog ENTRY schema — the SINGLE source of truth shared by
// the live registry parse (models.ts `listSchema`) and the boot-snapshot re-validation here, so a
// snapshot is held to the exact same shape the live path accepts. Kept permissive as the live path
// needs it: `id` required; providers/architecture are `.nullish()` (the HF router omits these keys, the
// CSCS direct endpoint returns them as explicit null — `.optional()` would reject the null and load
// zero models) with passthrough so unknown upstream fields survive.
export const catalogEntrySchema = z
	.object({
		id: z.string(),
		description: z.string().optional(),
		providers: z
			.array(z.object({ supports_tools: z.boolean().optional() }).passthrough())
			.nullish(),
		architecture: z
			.object({
				input_modalities: z.array(z.string()).optional(),
			})
			.passthrough()
			.nullish(),
	})
	.passthrough();

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/**
 * The committed boot snapshot: exactly what `fetchModelCatalog` RETURNS (`CatalogEntry[]`, i.e. the
 * `data` array — NOT the raw `{data: […]}` wire envelope) plus the configured PRIMARY baseURL it was
 * fetched for and a build timestamp. See docs/plans/ttft-critical-path.md §C.
 */
export interface ModelsSnapshot {
	fetchedAt: string;
	baseURL: string;
	entries: CatalogEntry[];
}

const snapshotSchema = z.object({
	fetchedAt: z.string(),
	baseURL: z.string(),
	entries: z.array(catalogEntrySchema),
});

/**
 * Validate a committed snapshot for BOOT use against the CONFIGURED primary base URL. Returns the
 * parsed snapshot only when it is usable — otherwise `null`, so the caller falls back to the live
 * catalog fetch (byte-identical to before §C):
 *
 *  - absent/empty: raw null/undefined, an empty `baseURL`, or zero `entries` ⇒ null (the committed
 *    empty-default artifact, or a snapshot the build step never populated → live path).
 *  - invalid: fails the envelope/entry schema (a stale-shape snapshot) ⇒ null.
 *  - mismatched: `snapshot.baseURL` ≠ the configured primary base ⇒ null (the entries were captured
 *    for a different upstream than the one endpoints are shaped for; don't serve them).
 */
export function parseModelsSnapshot(
	raw: unknown,
	configuredBaseURL: string | undefined
): ModelsSnapshot | null {
	const parsed = snapshotSchema.safeParse(raw);
	if (!parsed.success) return null;
	const snap = parsed.data;
	if (!snap.baseURL || snap.entries.length === 0) return null;
	if (!configuredBaseURL || snap.baseURL !== configuredBaseURL) return null;
	return snap;
}

/**
 * Model-id set difference between the snapshot-built and live-built registries. `drifted` is true when
 * the two id SETS differ (a model added/removed upstream since the snapshot was committed) — the signal
 * to republish the live registry over the snapshot one. The returned id lists are SORTED for a stable
 * drift log.
 */
export function computeModelDrift(
	snapshotIds: string[],
	liveIds: string[]
): { drifted: boolean; snapshotIds: string[]; liveIds: string[] } {
	const snap = new Set(snapshotIds);
	const live = new Set(liveIds);
	const drifted = snap.size !== live.size || [...live].some((id) => !snap.has(id));
	return {
		drifted,
		snapshotIds: [...snap].sort(),
		liveIds: [...live].sort(),
	};
}
