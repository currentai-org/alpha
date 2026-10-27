/**
 * Per-user LAN/local inference endpoint CRUD (schema.ts's `local_inference_endpoints`).
 *
 * Zero or more rows per user, looked up per-request by `localModels.ts` and turned into synthetic
 * "local" models — never merged into the shared, boot-once model registry. Plain drizzle, not the
 * Mongo doc-store shape, same as turnOutcomes.ts.
 *
 * Keyed on `userId` — the shadow `users.id`, the same identity space `authCondition(locals)` and
 * every other per-user table (settings, conversations, ...) use, i.e. `locals.user._id.toString()`.
 * Not email: see schema.ts's header comment on this table for why.
 *
 * Every write/delete here scopes by `userId` in the query itself (never id alone) — the only thing
 * standing between one user and another user's row is this check, since the id space (`newId()`) is
 * opaque but not secret.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "./client";
import {
	localInferenceEndpoints,
	type LocalInferenceEndpointRow,
	type LocalInferenceHeader,
	type ManagedEndpointConfig,
} from "./schema";
import { newId } from "./ids";

export type { LocalInferenceEndpointRow, LocalInferenceHeader, ManagedEndpointConfig };

/** Every local endpoint this user has configured, oldest first (stable list order in the settings UI). */
export async function listLocalEndpointsForUserId(userId: string): Promise<LocalInferenceEndpointRow[]> {
	return getDb()
		.select()
		.from(localInferenceEndpoints)
		.where(eq(localInferenceEndpoints.userId, userId))
		.orderBy(localInferenceEndpoints.createdAt);
}

/** One specific endpoint, but ONLY if it belongs to this user — the authorization check for anything
 *  keyed off a client-supplied endpoint id (e.g. prewarm's parsed model id, or a delete request). */
export async function getLocalEndpointForUserAndId(
	userId: string,
	id: string
): Promise<LocalInferenceEndpointRow | null> {
	const rows = await getDb()
		.select()
		.from(localInferenceEndpoints)
		.where(and(eq(localInferenceEndpoints.userId, userId), eq(localInferenceEndpoints.id, id)))
		.limit(1);
	return rows[0] ?? null;
}

/** Adds a new local endpoint for this user. Callers are responsible for validating/normalizing
 *  `label`/`baseUrl`/`headers` first (see localModels.ts's normalizeLocalBaseUrl and the create
 *  route's zod schema) — this just persists. `headers` defaults to `[]`; CUR-1291 applies whatever's
 *  stored here to every request this endpoint makes (see localModels.ts's headersRecord()).
 *
 *  `kind`/`managedConfig` default to "direct"/null — the original CUR-1194/CUR-1262 shape.
 *  The managed provisioning route (api/v2/user/local-inference-endpoints/managed) is the only (CUR-1266)
 *  caller that passes `kind: "managed"` + a real `managedConfig`. */
export async function createLocalEndpoint(input: {
	userId: string;
	label: string;
	baseUrl: string;
	headers?: LocalInferenceHeader[];
	kind?: "direct" | "managed";
	managedConfig?: ManagedEndpointConfig | null;
}): Promise<LocalInferenceEndpointRow> {
	const id = newId();
	const [row] = await getDb()
		.insert(localInferenceEndpoints)
		.values({
			...input,
			id,
			headers: input.headers ?? [],
			kind: input.kind ?? "direct",
			managedConfig: input.managedConfig ?? null,
		})
		.returning();
	return row;
}

/** Deletes one endpoint, scoped to its owner. Returns whether a row was actually deleted (false for
 *  "not found" and "belongs to someone else" alike — a caller has no business telling those apart). */
export async function deleteLocalEndpoint(userId: string, id: string): Promise<boolean> {
	const deleted = await getDb()
		.delete(localInferenceEndpoints)
		.where(and(eq(localInferenceEndpoints.userId, userId), eq(localInferenceEndpoints.id, id)))
		.returning({ id: localInferenceEndpoints.id });
	return deleted.length > 0;
}
