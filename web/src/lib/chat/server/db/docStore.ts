/**
 * Document-store collection adapter — a MongoDB-shaped API backed by Drizzle/Postgres (NOT MongoDB).
 *
 * There is no Mongo here: this presents the *shape* of the Mongo collection API so the inherited
 * chat-ui call sites keep working, while every read/write actually hits Postgres. The ~100
 * `collections.X.<method>(...)` call sites and the `_id: ObjectId` document shape the app is built on
 * stay as they are.
 * Each collection is a table of `id` + indexed projection columns + a `doc` JSONB column
 * (see schema.ts). This adapter presents the small, uniform subset of the Mongo collection API the
 * runtime actually uses (findOne / find / insertOne / updateOne(+upsert) / deleteOne / deleteMany /
 * countDocuments / aggregate-free), translating filters/updates to Drizzle and projecting indexed
 * fields into columns on every write.
 *
 * Documents are stored as "extended JSON": Date → {$dt}, ObjectId → {$oid}, recursively. This makes
 * dates and ObjectIds round-trip faithfully ANYWHERE in the document (incl. nested fields such as
 * session.oauth.token.expiresAt), which a plain JSONB cast would lose.
 *
 * Written fresh for this fork (our own code; no Vercel reference copied).
 */
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	isNotNull,
	lt,
	lte,
	ne,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { ObjectId } from "bson";
import { getDb, withTransaction } from "./client";
import { newId } from "./ids";

// ── extended-JSON encode / decode ────────────────────────────────────────────
function isObjectIdLike(v: unknown): v is { toHexString(): string } {
	return (
		!!v &&
		typeof v === "object" &&
		typeof (v as { toHexString?: unknown }).toHexString === "function"
	);
}

/** Replace Date/ObjectId with tagged markers so they survive a JSONB round-trip anywhere in the doc. */
function toStorage(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") {
		// Postgres jsonb cannot store U+0000 — it's the one codepoint it rejects outright ("unsupported
		// Unicode escape sequence"). A pasted or crafted null byte anywhere in a message would otherwise
		// fail the whole conversation write (a 500 on send). Strip it at the storage boundary so every
		// write is safe; the includes() guard keeps the normal path allocation-free.
		// eslint-disable-next-line no-control-regex -- stripping U+0000 is the intent (see above)
		return value.includes("\u0000") ? value.replace(/\u0000/g, "") : value;
	}
	if (value instanceof Date) return { $dt: value.toISOString() };
	if (isObjectIdLike(value)) return { $oid: value.toHexString() };
	if (Array.isArray(value)) return value.map(toStorage);
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toStorage(v);
		return out;
	}
	return value;
}

/** Inverse of toStorage: revive {$dt}/{$oid} markers back into Date/ObjectId. */
function fromStorage(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map(fromStorage);
	if (typeof value === "object") {
		const keys = Object.keys(value as object);
		if (keys.length === 1 && keys[0] === "$dt") {
			return new Date((value as { $dt: string }).$dt);
		}
		if (keys.length === 1 && keys[0] === "$oid") {
			return new ObjectId((value as { $oid: string }).$oid);
		}
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fromStorage(v);
		return out;
	}
	return value;
}

// ── spec ──────────────────────────────────────────────────────────────────────
export type ColKind = "text" | "date";
export interface CollectionSpec {
	table: PgTable;
	/** Drizzle property name of the primary-key column. */
	idProp: string;
	/** Mongo document field that is the identity (usually "_id"; "key" for config). */
	idField: string;
	/** Whether to expose the identity as `_id: ObjectId` on read (false for the key/value config table). */
	emitObjectId: boolean;
	/** Indexed projection columns (excluding the PK): mongoField → { drizzle prop, kind }. */
	cols: Record<string, { prop: string; kind: ColKind }>;
}

type Doc = Record<string, unknown>;
type Filter = Record<string, unknown>;
type Update = { $set?: Doc; $setOnInsert?: Doc; $unset?: Doc };

// Permissive write/filter inputs (we don't replicate mongodb's full generic typing; reads are typed).
type WriteResult = {
	acknowledged: boolean;
	matchedCount: number;
	modifiedCount: number;
	upsertedId: ObjectId | null;
};

export interface Cursor<T> {
	sort(sortSpec: Record<string, 1 | -1>): Cursor<T>;
	skip(n: number): Cursor<T>;
	limit(n: number): Cursor<T>;
	project<P = T>(projection?: Record<string, 0 | 1>): Cursor<P>;
	toArray(): Promise<T[]>;
	next(): Promise<T | null>;
}

/** Insert input: accepts a typed document (with optional _id) or a plain object literal. */
export type InsertDoc<T> = (Omit<T, "_id"> & { _id?: ObjectId }) | Record<string, unknown>;

export interface AdaptedCollection<T> {
	findOne(filter?: Filter): Promise<T | null>;
	find(filter?: Filter): Cursor<T>;
	insertOne(doc: InsertDoc<T>): Promise<{ acknowledged: boolean; insertedId: ObjectId }>;
	insertMany(
		docs: InsertDoc<T>[]
	): Promise<{ acknowledged: boolean; insertedCount: number; insertedIds: ObjectId[] }>;
	updateOne(filter: Filter, update: Update, opts?: { upsert?: boolean }): Promise<WriteResult>;
	/**
	 * Read the first match and write `change(current)` back while holding its row lock, so no other
	 * write lands between the read and the write. For an update that depends on what is stored now,
	 * such as merging into a list another request may have grown. `change` returning null writes
	 * nothing. It must not query the database itself.
	 */
	modifyOne(filter: Filter, change: (current: T) => Update | null): Promise<WriteResult>;
	updateMany(filter: Filter, update: Update): Promise<WriteResult>;
	deleteOne(filter: Filter): Promise<{ acknowledged: boolean; deletedCount: number }>;
	deleteMany(filter?: Filter): Promise<{ acknowledged: boolean; deletedCount: number }>;
	countDocuments(filter?: Filter): Promise<number>;
}

function col(table: PgTable, prop: string): PgColumn {
	return (table as unknown as Record<string, PgColumn>)[prop];
}

/** Postgres unique_violation (23505), however drizzle wraps the driver error. */
function isUniqueViolation(err: unknown): boolean {
	const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
	return e?.code === "23505" || e?.cause?.code === "23505";
}

function coerceId(v: unknown): string {
	return isObjectIdLike(v) ? v.toHexString() : String(v);
}

function coerceCol(v: unknown, kind: ColKind): unknown {
	if (v === null || v === undefined) return null;
	if (kind === "date") return v instanceof Date ? v : new Date(v as string);
	return isObjectIdLike(v) ? v.toHexString() : String(v);
}

function isOperatorObject(v: unknown): v is Record<string, unknown> {
	return (
		!!v &&
		typeof v === "object" &&
		!Array.isArray(v) &&
		!(v instanceof Date) &&
		!isObjectIdLike(v) &&
		Object.keys(v).some((k) => k.startsWith("$"))
	);
}

export function docCollection<T = Doc>(spec: CollectionSpec): AdaptedCollection<T> {
	const { table, idProp, idField, emitObjectId, cols } = spec;

	function resolveCol(field: string): PgColumn | undefined {
		if (field === idField || field === "_id") return col(table, idProp);
		const c = cols[field];
		return c ? col(table, c.prop) : undefined;
	}
	function kindOf(field: string): ColKind {
		if (field === idField || field === "_id") return "text";
		return cols[field]?.kind ?? "text";
	}

	function buildWhere(filter: Filter | undefined) {
		if (!filter) return undefined;
		const conds = [];
		for (const [key, val] of Object.entries(filter)) {
			const column = resolveCol(key);
			const kind = kindOf(key);
			if (!column) {
				// Fallback to a JSONB path for any non-indexed field (rare; runtime filters are all indexed).
				if (isOperatorObject(val) && "$exists" in val) {
					conds.push(
						val.$exists
							? sql`${col(table, "doc")} ? ${key}`
							: sql`NOT (${col(table, "doc")} ? ${key})`
					);
				} else {
					conds.push(sql`${col(table, "doc")}->>${key} = ${String(val)}`);
				}
				continue;
			}
			if (isOperatorObject(val)) {
				for (const [op, opv] of Object.entries(val)) {
					switch (op) {
						case "$gt":
							conds.push(gt(column, coerceCol(opv, kind)));
							break;
						case "$gte":
							conds.push(gte(column, coerceCol(opv, kind)));
							break;
						case "$lt":
							conds.push(lt(column, coerceCol(opv, kind)));
							break;
						case "$lte":
							conds.push(lte(column, coerceCol(opv, kind)));
							break;
						case "$ne":
							conds.push(ne(column, coerceCol(opv, kind)));
							break;
						case "$exists":
							conds.push(opv ? isNotNull(column) : isNull(column));
							break;
						// Mongo's semantics: $in never matches a missing field, $nin always does. An empty
						// list is spelled out rather than left to the SQL builder: $in [] matches nothing,
						// $nin [] matches everything.
						case "$in": {
							const list = (opv as unknown[]).map((v) => coerceCol(v, kind));
							conds.push(list.length ? inArray(column, list) : sql`false`);
							break;
						}
						case "$nin": {
							const list = (opv as unknown[]).map((v) => coerceCol(v, kind));
							if (list.length) conds.push(or(isNull(column), notInArray(column, list))!);
							break;
						}
						default:
							throw new Error(`docStore: unsupported filter operator ${op} on ${key}`);
					}
				}
			} else {
				conds.push(eq(column, coerceCol(val, kind)));
			}
		}
		if (conds.length === 0) return undefined;
		return conds.length === 1 ? conds[0] : and(...conds);
	}

	/** Build a Drizzle row (PK + projection columns + encoded doc) from a document and identity. */
	function deriveRow(doc: Doc, id: string): Record<string, unknown> {
		const row: Record<string, unknown> = { [idProp]: id };
		for (const [field, { prop, kind }] of Object.entries(cols)) {
			row[prop] = coerceCol(doc[field], kind);
		}
		const stored: Doc = {};
		for (const [k, v] of Object.entries(doc)) {
			if (k === idField || k === "_id") continue;
			stored[k] = v;
		}
		row.doc = toStorage(stored);
		return row;
	}

	/**
	 * The column values an update writes, with `doc` as one in-place JSONB edit of only the keys the
	 * update names (CUR-2806). Writing the whole document back instead would make two updates to
	 * different keys race: each would write the copy it had read, and the later one would undo the
	 * earlier. A `$set` to undefined drops the key, as writing the whole document back would. Null when
	 * it changes nothing.
	 */
	function patchFor(update: Update): Record<string, unknown> | null {
		const set: Record<string, unknown> = {};
		const patch: Doc = {};
		const drop: string[] = [];
		for (const [k, v] of Object.entries(update.$set ?? {})) {
			if (k === idField || k === "_id") continue; // identity is immutable
			if (v === undefined) drop.push(k);
			else patch[k] = v;
			const c = cols[k];
			if (c) set[c.prop] = coerceCol(v, c.kind);
		}
		for (const k of Object.keys(update.$unset ?? {})) {
			if (k === idField || k === "_id") continue;
			drop.push(k);
			const c = cols[k];
			if (c) set[c.prop] = null;
		}
		if (drop.length === 0 && Object.keys(patch).length === 0) return null;
		let doc = sql`coalesce(${col(table, "doc")}, '{}'::jsonb)`;
		for (const k of drop) doc = sql`(${doc} - ${k}::text)`;
		if (Object.keys(patch).length) doc = sql`(${doc} || ${JSON.stringify(toStorage(patch))}::jsonb)`;
		set.doc = doc;
		return set;
	}

	/** Reconstruct a Mongo-shaped document (with revived Date/ObjectId and identity) from a row. */
	function reconstruct(row: Record<string, unknown>): Doc {
		const doc = (fromStorage(row.doc) as Doc) ?? {};
		const id = row[idProp] as string;
		if (emitObjectId) doc._id = new ObjectId(id);
		else doc[idField] = id;
		return doc;
	}

	function applyUpdate(doc: Doc, update: Update, includeSetOnInsert: boolean) {
		if (update.$set) {
			for (const [k, v] of Object.entries(update.$set)) {
				if (k === idField || k === "_id") continue; // identity is immutable
				doc[k] = v;
			}
		}
		if (includeSetOnInsert && update.$setOnInsert) {
			for (const [k, v] of Object.entries(update.$setOnInsert)) {
				if (k === idField || k === "_id") continue;
				doc[k] = v;
			}
		}
		if (update.$unset) {
			for (const k of Object.keys(update.$unset)) delete doc[k];
		}
	}

	function seedFromFilter(filter: Filter): Doc {
		// Mongo upsert seeds the new document with the filter's equality fields — including the
		// identity field when it IS an equality predicate (e.g. config's {key}). Operator predicates
		// like {userId:{$exists:false}} are not seeded.
		const doc: Doc = {};
		for (const [k, v] of Object.entries(filter)) {
			if (isOperatorObject(v)) continue;
			doc[k] = v;
		}
		return doc;
	}

	function wrapId(id: string): ObjectId | string {
		return emitObjectId ? new ObjectId(id) : id;
	}

	const api = {
		async findOne(filter: Filter = {}) {
			const db = getDb();
			const rows = await db
				.select()
				.from(table)
				.where(buildWhere(filter) as never)
				.limit(1);
			return rows[0] ? reconstruct(rows[0] as Record<string, unknown>) : null;
		},

		async insertOne(doc: Doc) {
			const db = getDb();
			const id = doc[idField] !== undefined ? coerceId(doc[idField]) : newId();
			await db.insert(table).values(deriveRow(doc, id) as never);
			return { acknowledged: true, insertedId: wrapId(id) };
		},

		async insertMany(docs: Doc[]) {
			const db = getDb();
			const ids: (ObjectId | string)[] = [];
			const rows = docs.map((doc) => {
				const id = doc[idField] !== undefined ? coerceId(doc[idField]) : newId();
				ids.push(wrapId(id));
				return deriveRow(doc, id);
			});
			if (rows.length) await db.insert(table).values(rows as never);
			return { acknowledged: true, insertedCount: rows.length, insertedIds: ids };
		},

		async updateOne(filter: Filter, update: Update, opts: { upsert?: boolean } = {}): Promise<WriteResult> {
			const db = getDb();
			const rows = await db
				.select({ id: col(table, idProp) })
				.from(table)
				.where(buildWhere(filter) as never)
				.limit(1);
			if (rows[0]) {
				const set = patchFor(update);
				if (set) {
					await db
						.update(table)
						.set(set as never)
						.where(eq(col(table, idProp), rows[0].id as string));
				}
				return { acknowledged: true, matchedCount: 1, modifiedCount: set ? 1 : 0, upsertedId: null };
			}
			if (opts.upsert) {
				const doc = seedFromFilter(filter);
				applyUpdate(doc, update, true);
				const id = doc[idField] !== undefined ? coerceId(doc[idField]) : newId();
				try {
					await db.insert(table).values(deriveRow(doc, id) as never);
				} catch (err) {
					// Another request inserted the same row between our read and this insert: update the
					// row it made, as an upsert that had arrived second would have.
					if (!isUniqueViolation(err)) throw err;
					return api.updateOne(filter, update);
				}
				return {
					acknowledged: true,
					matchedCount: 0,
					modifiedCount: 0,
					// A string for the key/value config table; the interface names the common case.
					upsertedId: wrapId(id) as ObjectId,
				};
			}
			return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
		},

		async modifyOne(filter: Filter, change: (current: T) => Update | null): Promise<WriteResult> {
			return withTransaction(async () => {
				const db = getDb();
				const rows = await db
					.select()
					.from(table)
					.where(buildWhere(filter) as never)
					.limit(1)
					.for("update");
				if (!rows[0]) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
				const row = rows[0] as Record<string, unknown>;
				const update = change(reconstruct(row) as T);
				const set = update && patchFor(update);
				if (set) {
					await db
						.update(table)
						.set(set as never)
						.where(eq(col(table, idProp), row[idProp] as string));
				}
				return { acknowledged: true, matchedCount: 1, modifiedCount: set ? 1 : 0, upsertedId: null };
			});
		},

		async updateMany(filter: Filter, update: Update): Promise<WriteResult> {
			const db = getDb();
			const set = patchFor(update);
			const matched = set
				? (
						await db
							.update(table)
							.set(set as never)
							.where(buildWhere(filter) as never)
							.returning({ id: col(table, idProp) })
					).length
				: await api.countDocuments(filter);
			return {
				acknowledged: true,
				matchedCount: matched,
				modifiedCount: set ? matched : 0,
				upsertedId: null,
			};
		},

		async deleteOne(filter: Filter) {
			const db = getDb();
			const rows = await db
				.select({ id: col(table, idProp) })
				.from(table)
				.where(buildWhere(filter) as never)
				.limit(1);
			if (!rows[0]) return { acknowledged: true, deletedCount: 0 };
			await db.delete(table).where(eq(col(table, idProp), rows[0].id as string));
			return { acknowledged: true, deletedCount: 1 };
		},

		async deleteMany(filter: Filter = {}) {
			const db = getDb();
			const deleted = await db
				.delete(table)
				.where(buildWhere(filter) as never)
				.returning({ id: col(table, idProp) });
			return { acknowledged: true, deletedCount: deleted.length };
		},

		async countDocuments(filter: Filter = {}): Promise<number> {
			const db = getDb();
			const rows = await db
				.select({ n: sql<number>`count(*)::int` })
				.from(table)
				.where(buildWhere(filter) as never);
			return rows[0]?.n ?? 0;
		},

		find(filter: Filter = {}) {
			const where = buildWhere(filter);
			const orderBy: ReturnType<typeof asc>[] = [];
			let lim: number | undefined;
			let off: number | undefined;
			const cursor = {
				sort(sortSpec: Record<string, 1 | -1>) {
					for (const [field, dir] of Object.entries(sortSpec)) {
						const c = resolveCol(field) ?? col(table, "doc");
						orderBy.push(dir < 0 ? desc(c) : asc(c));
					}
					return cursor;
				},
				skip(n: number) {
					off = n;
					return cursor;
				},
				limit(n: number) {
					lim = n;
					return cursor;
				},
				// Projection is a no-op: returning the full document is a superset and harmless.
				project<T = Doc>() {
					return cursor as unknown as typeof cursor & { __projected: T };
				},
				async toArray() {
					const db = getDb();
					let q = db
						.select()
						.from(table)
						.where(where as never)
						.$dynamic();
					if (orderBy.length) q = q.orderBy(...orderBy);
					if (off !== undefined) q = q.offset(off);
					if (lim !== undefined) q = q.limit(lim);
					const rows = await q;
					return rows.map((r) => reconstruct(r as Record<string, unknown>));
				},
				async next() {
					const db = getDb();
					let q = db
						.select()
						.from(table)
						.where(where as never)
						.$dynamic();
					if (orderBy.length) q = q.orderBy(...orderBy);
					q = q.limit(1);
					const rows = await q;
					return rows[0] ? reconstruct(rows[0] as Record<string, unknown>) : null;
				},
			};
			return cursor;
		},
		// The runtime returns documents as plain objects; T labels the read shape for call sites.
	};
	return api as unknown as AdaptedCollection<T>;
}

export type DocCollection = ReturnType<typeof docCollection>;
