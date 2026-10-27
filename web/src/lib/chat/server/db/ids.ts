/**
 * Shared id helper for the Postgres persistence layer.
 *
 * Produces a 24-char hex string (Mongo ObjectId-compatible width) so existing routes that parse
 * `new ObjectId(params.id)` and serialize `_id.toString()` keep working unchanged on Postgres.
 * Kept dependency-free so it is importable by both the
 * SvelteKit server and a plain Node verification harness.
 */
import { randomBytes } from "crypto";

/** 12 random bytes → 24 hex chars, matching Mongo ObjectId width. */
export function newId(): string {
	return randomBytes(12).toString("hex");
}
