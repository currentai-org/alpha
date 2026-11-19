/**
 * Writes a read Open WebUI database into Alpha: accounts first, then conversations.
 *
 * @remarks
 * Accounts. A person is matched on the identity provider's subject id (the `sub` Open WebUI stored
 * under `user.oauth.<provider>`), then on email, and created when neither finds them. A created person
 * gets the shadow `users` row Alpha reads, and, when a subject id exists, the `account` row the
 * organisation's OIDC sign-in resolves on (providerId `org-oidc`), so their first sign-in lands on
 * the imported history. Nothing is asked of them.
 *
 * Conversations are written through `conversationWrites`, the save path a chat turn uses. Each carries
 * `syncOrigin: open-webui-import` and `syncClientId: <Open WebUI chat id>` (the key the removed Thunderbolt sync
 * used), plus a fingerprint of what the source held. A rerun finds the conversation by that key, leaves
 * it alone when the fingerprint matches, and merges the changes in when it does not. It never deletes: a
 * message removed at the source, or one the person added in Alpha since, stays.
 *
 * Files come before conversations, through Alpha's own upload path (files.ts), so each one
 * passes the safety scan and gets a text sidecar. Without `files` in the options they are counted and
 * skipped with that reason, never silently left out of the report. A message whose Open WebUI `files`
 * names an imported file holds the same reference a chat attachment holds; one whose file was
 * skipped keeps its text and is named in the report's `attachmentSkips`.
 *
 * Tags are copied as Open WebUI keeps them: each `tag` row becomes the person's own
 * `conversation_tags` row under the same id, and a chat's `meta.tags` becomes its tag list. A tag the
 * person already has in Alpha keeps the name they gave it. Like a pin, a chat's tags are set on its first
 * import only; after that they are the person's own.
 *
 * Sealing. Where this deployment seals history (the `history-seal-writes` flag), each imported chat
 * is sealed to its owner's history recipient as it is written, title and messages, the way a chat turn's
 * are, so no imported words reach `conversations.doc` in plaintext. An owner with no history key yet (one
 * this run created, or one who has never signed in since enrolment shipped) has nothing to seal to, so
 * their chats are refused: each is skipped with that reason and the person is marked `sealRefused`, which
 * the CLI reports and exits 1 on. Signing in once makes the key; a rerun then imports them.
 *
 * History is stored unscreened: no message carries a moderation verdict, and `meta.imported.screened`
 * says so, so a missing verdict is never read as a screen that failed open.
 */
import { ObjectId } from "bson";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { collections } from "$lib/chat/server/database";
import { getDb, withTransaction } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { shadowUserId } from "$lib/chat/server/auth";
import { saveConversationMessages, snapshotConversation } from "$lib/chat/server/chat/conversationWrites";
import { ORG_OIDC_PROVIDER_ID } from "$lib/chat/server/orgOidc";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import { convertChat, epochToMs, IMPORT_ORIGIN, type ConvertedConversation } from "./convert";
import type { SourceChat, SourceData, SourceUser } from "./sourceRows";
import { importFiles, type FileDeps, type FileOwner, type ImportedFile } from "./files";
import { emptyUserReport, type ImportReport, type UserReport } from "./report";
import { ensureTags } from "$lib/chat/server/db/conversationTags";
import { conversationSealWritesOn, ownerSealer, type ConversationSealer } from "$lib/chat/server/chat/sealedTurn";

export interface ImportOptions {
	/** The model every imported conversation is stored under; Alpha's default for new chats. */
	model: string;
	/** The key under `user.oauth` that holds the subject id. Open WebUI names it for the provider. */
	oauthProvider?: string;
	/** Convert and count everything, touch nothing. */
	dryRun?: boolean;
	now?: Date;
	/** How to read and store uploaded files. Absent: every file is reported as skipped, not imported. */
	files?: FileDeps;
	/** Seals one owner's conversations, or null when nothing should be sealed for them. Defaults to
	 *  sealedTurn.ts's `ownerSealer`; tests pass their own. */
	sealerFor?: (owner: { userId: ObjectId }) => Promise<((conversationId: string) => ConversationSealer) | null>;
	/** Whether this deployment seals history. Defaults to the `history-seal-writes` flag. */
	sealWritesOn?: () => boolean;
}

/** Why an owner's chats are not imported while this deployment seals history. */
export const NO_HISTORY_KEY_REASON =
	"this deployment seals chat history (history-seal-writes) and the owner has no history key to seal to yet; " +
	"they sign in once to make one, then rerun the import";

/** How one owner's chats are written: in plaintext (sealing is off), sealed, or refused with a reason. */
type OwnerSealing = { kind: "plain" } | { kind: "sealed"; sealer: (conversationId: string) => ConversationSealer } | { kind: "refused"; reason: string };

async function sealingFor(owner: ObjectId, opts: ImportOptions): Promise<OwnerSealing> {
	if (!(opts.sealWritesOn ?? conversationSealWritesOn)()) return { kind: "plain" };
	let sealer: ((conversationId: string) => ConversationSealer) | null;
	try {
		sealer = await (opts.sealerFor ?? ownerSealer)({ userId: owner });
	} catch (e) {
		return { kind: "refused", reason: `the owner's history key could not be read: ${e instanceof Error ? e.message : String(e)}` };
	}
	return sealer ? { kind: "sealed", sealer } : { kind: "refused", reason: NO_HISTORY_KEY_REASON };
}

/** The subject id Open WebUI recorded for `provider`, or null. */
function subjectOf(user: Pick<SourceUser, "oauth">, provider: string): string | null {
	const sub = (user.oauth as Record<string, { sub?: unknown } | undefined> | null)?.[provider]?.sub;
	return typeof sub === "string" && sub !== "" ? sub : null;
}

type Resolved = { shadow: ObjectId; how: UserReport["account"] };

async function findBySubject(sub: string): Promise<string | null> {
	const [row] = await getDb()
		.select({ userId: schema.account.userId })
		.from(schema.account)
		.where(and(eq(schema.account.providerId, ORG_OIDC_PROVIDER_ID), eq(schema.account.accountId, sub)))
		.limit(1);
	return row?.userId ?? null;
}

async function findByEmail(email: string): Promise<string | null> {
	const [row] = await getDb()
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(sql`lower(${schema.user.email}) = ${email}`)
		.limit(1);
	return row?.id ?? null;
}

/** Finds or creates the Alpha person for `u`. A person found keeps every field they already have. */
async function resolveUser(u: SourceUser, sub: string | null, now: Date): Promise<Resolved> {
	const email = u.email.trim().toLowerCase();
	const bySub = sub ? await findBySubject(sub) : null;
	const existing = bySub ?? (await findByEmail(email));
	let baId = existing;
	let how: Resolved["how"] = bySub ? "matched on subject id" : existing ? "matched on email" : "created";
	if (!baId) {
		baId = randomUUID();
		const created = new Date(epochToMs(u.createdAt) ?? now.getTime());
		const id = baId;
		await withTransaction(async () => {
			await getDb()
				.insert(schema.user)
				.values({ id, name: u.name || email, email, emailVerified: false, image: null, createdAt: created, updatedAt: now });
			if (sub) {
				await getDb()
					.insert(schema.account)
					.values({ id: randomUUID(), accountId: sub, providerId: ORG_OIDC_PROVIDER_ID, userId: id, createdAt: created, updatedAt: now });
			}
		});
	} else if (sub && !bySub) {
		// Found by email: link the subject id so the sign-in resolves on it, unless this person already has an account here.
		const id = baId;
		const has = await getDb()
			.select({ id: schema.account.id })
			.from(schema.account)
			.where(and(eq(schema.account.providerId, ORG_OIDC_PROVIDER_ID), eq(schema.account.userId, id)))
			.limit(1);
		if (!has.length) {
			await getDb()
				.insert(schema.account)
				.values({ id: randomUUID(), accountId: sub, providerId: ORG_OIDC_PROVIDER_ID, userId: id, createdAt: now, updatedAt: now });
			how = "matched on email, subject id linked";
		}
	}
	const shadow = new ObjectId(await shadowUserId(baId));
	if (!(await collections.users.findOne({ _id: shadow }))) {
		await collections.users.insertOne({
			_id: shadow,
			name: u.name || email,
			email,
			avatarUrl: undefined,
			betterAuthUserId: baId,
			createdAt: new Date(epochToMs(u.createdAt) ?? now.getTime()),
			updatedAt: now,
		});
	}
	return { shadow, how };
}

const importedMeta = (fingerprint: string): NonNullable<Conversation["meta"]> => ({
	imported: { source: "open-webui", screened: false, fingerprint },
});

async function writeChat(
	owner: ObjectId,
	chat: SourceChat,
	converted: ConvertedConversation,
	opts: ImportOptions,
	sealing: Exclude<OwnerSealing, { kind: "refused" }>
): Promise<"imported" | "updated" | "unchanged"> {
	const key = { userId: owner, syncClientId: chat.id, syncOrigin: IMPORT_ORIGIN };
	const existing = await collections.conversations.findOne(key);
	if (!existing) {
		// A tag id with no `tag` row at the source still gets one, named after its id, so the chat's tag shows.
		await ensureTags(owner.toString(), chat.tags.map((id) => ({ id, name: id })));
		const _id = new ObjectId();
		// Sealed before the insert, so the words never reach the row in plaintext, not even for a moment.
		const sealer = sealing.kind === "sealed" ? sealing.sealer(_id.toString()) : null;
		const messages = sealer ? await Promise.all(converted.messages.map((m) => sealer.message(m))) : converted.messages;
		const title = sealer ? { title: "", ...(await sealer.title(converted.title, 0)) } : { title: converted.title };
		await collections.conversations.insertOne({
			_id,
			...title,
			rootMessageId: converted.messages[0].id,
			messages,
			model: opts.model,
			preprompt: "",
			createdAt: converted.createdAt,
			updatedAt: converted.updatedAt,
			userId: owner,
			syncClientId: chat.id,
			syncOrigin: IMPORT_ORIGIN,
			meta: importedMeta(converted.fingerprint),
			// Set on the first import only: after that a pin or an archive is the person's own, made in Alpha.
			...(chat.pinned ? { pinned: true } : {}),
			...(chat.archived ? { archived: true } : {}),
			...(chat.tags.length ? { tags: chat.tags } : {}),
		});
		return "imported";
	}
	if (existing.meta?.imported?.fingerprint === converted.fingerprint) return "unchanged";
	const ours = new Set(converted.messages.map((m) => m.id));
	const kept = existing.messages.filter((m) => !ours.has(m.id));
	const keptIds = new Set(kept.map((m) => m.id));
	const was = new Map(existing.messages.map((m) => [m.id, m]));
	// The source knows only its own children. A reply added in Alpha, or a message the source has since
	// dropped, stays listed under its parent, or nothing would reach it.
	const next: Message[] = [
		...converted.messages.map((m) => {
			const prior = was.get(m.id);
			const extra = (prior?.children ?? []).filter((id) => keptIds.has(id) && !m.children?.includes(id));
			const withChildren = extra.length ? { ...m, children: [...(m.children ?? []), ...extra] } : m;
			// A message stored sealed is resealed at its next revision by the save below.
			return prior?.sealedRev !== undefined ? { ...withChildren, sealedRev: prior.sealedRev } : withChildren;
		}),
		...kept,
	];
	await saveConversationMessages({ _id: existing._id, userId: owner }, snapshotConversation(existing), {
		messages: next,
		title: converted.title,
		// A conversation the person kept using in Alpha stays where it is in their list.
		updatedAt: existing.updatedAt > converted.updatedAt ? existing.updatedAt : converted.updatedAt,
	});
	await collections.conversations.updateOne({ _id: existing._id, userId: owner }, { $set: { meta: { ...existing.meta, ...importedMeta(converted.fingerprint) } } });
	return "updated";
}

/** How many of the converted messages (not the root) are stored now. */
async function storedCount(owner: ObjectId, chatId: string, expected: Message[]): Promise<number> {
	const stored = await collections.conversations.findOne({ userId: owner, syncClientId: chatId, syncOrigin: IMPORT_ORIGIN });
	const have = new Set((stored?.messages ?? []).map((m) => m.id));
	return expected.slice(1).filter((m) => have.has(m.id)).length;
}

function forUser(all: Map<string, Map<string, ImportedFile>>, userId: string): Map<string, ImportedFile> {
	let m = all.get(userId);
	if (!m) all.set(userId, (m = new Map()));
	return m;
}

export async function runImport(source: SourceData, opts: ImportOptions): Promise<ImportReport> {
	const now = opts.now ?? new Date();
	const provider = opts.oauthProvider ?? "oidc";
	const reports = new Map<string, UserReport>();
	const orphan: UserReport = emptyUserReport("(no matching user row)", "");
	// "dry" stands for a person a dry run would resolve; null is a person who cannot be imported.
	const owners = new Map<string, Resolved | "dry" | null>();

	for (const u of source.users) {
		const sub = subjectOf(u, provider);
		const r = emptyUserReport(u.id, u.email);
		r.subjectId = sub !== null;
		reports.set(u.id, r);
		if (!u.email.trim()) {
			r.account = "skipped";
			r.accountNote = "the user has no email";
			owners.set(u.id, null);
			continue;
		}
		if (opts.dryRun) {
			r.account = "would resolve";
			owners.set(u.id, "dry");
			continue;
		}
		const resolved = await resolveUser(u, sub, now);
		r.account = resolved.how;
		owners.set(u.id, resolved);
	}

	// Files come before conversations: a message's reference to its file needs the file's id map and sha.
	const byUser = new Map<string, Map<string, ImportedFile>>();
	if (opts.files) {
		const fileOwners = new Map<string, FileOwner>();
		for (const [id, o] of owners) fileOwners.set(id, o === "dry" ? "dry" : o ? o.shadow.toString() : null);
		const made = await importFiles(source.files, fileOwners, (id) => reports.get(id) ?? orphan, opts.files);
		for (const f of source.files) if (made.has(f.id)) forUser(byUser, f.userId).set(f.id, made.get(f.id)!);
	} else {
		for (const f of source.files) {
			const r = reports.get(f.userId) ?? orphan;
			const reason = "files were not requested on this run (--no-files)";
			r.files.in += 1;
			r.files.skipped.push({ id: f.id, reason });
			forUser(byUser, f.userId).set(f.id, { ok: false, reason });
		}
	}

	// Tag rows before conversations, so a chat's tags name rows that exist.
	for (const t of source.tags) {
		const r = reports.get(t.userId) ?? orphan;
		r.tags.in += 1;
		const owner = owners.get(t.userId);
		if (!owner) {
			const reason = reports.has(t.userId) ? (r.accountNote ?? "the owner was not created") : "the tag's user_id matches no user row";
			r.tags.skipped.push({ id: t.id, reason });
			continue;
		}
		if (owner !== "dry") await ensureTags(owner.shadow.toString(), [{ id: t.id, name: t.name, meta: t.meta }]);
		r.tags.stored += 1;
	}

	const sealings = new Map<string, OwnerSealing>();
	for (const chat of source.chats) {
		const report = reports.get(chat.userId) ?? orphan;
		report.conversations.in += 1;
		// A dry run writes no files, so no message gets a reference to count. Only the chat owner's own files resolve.
		const converted = convertChat(chat, source.messageRows.get(chat.id), opts.dryRun ? undefined : (byUser.get(chat.userId) ?? new Map()));
		if (!converted.ok) {
			report.conversations.skipped.push({ id: chat.id, reason: converted.reason });
			continue;
		}
		const c = converted.value;
		report.messages.in += c.sourceMessages;
		report.messages.skipped += c.skipped.length;
		report.droppedBlocks += c.droppedBlocks;
		for (const s of c.skipped) report.messageSkips.push({ chatId: chat.id, ...s });
		for (const s of c.attachmentSkips) report.attachmentSkips.push({ chatId: chat.id, ...s });
		const expected = c.messages.length - 1;
		const owner = owners.get(chat.userId);
		if (!owner) {
			report.conversations.skipped.push({
				id: chat.id,
				reason: reports.has(chat.userId) ? (report.accountNote ?? "the owner was not created") : "the chat's user_id matches no user row",
			});
			report.messages.skipped += expected;
			continue;
		}
		if (owner === "dry") {
			report.conversations.imported += 1;
			report.messages.stored += expected;
			continue;
		}
		// Where history is sealed, an owner with nothing to seal to gets none of their chats written.
		const ownerId = owner.shadow.toString();
		let sealing = sealings.get(ownerId);
		if (!sealing) sealings.set(ownerId, (sealing = await sealingFor(owner.shadow, opts)));
		if (sealing.kind === "refused") {
			report.conversations.skipped.push({ id: chat.id, reason: sealing.reason });
			report.messages.skipped += expected;
			report.sealRefused = sealing.reason;
			continue;
		}
		const outcome = await writeChat(owner.shadow, chat, c, opts, sealing);
		if (outcome === "imported") report.conversations.imported += 1;
		else if (outcome === "updated") report.conversations.updated += 1;
		else report.conversations.unchanged += 1;
		// An unchanged conversation is not read back: its source matches what was stored, and the person may
		// have deleted messages in Alpha since, which is not an import fault.
		const stored = outcome === "unchanged" ? expected : await storedCount(owner.shadow, chat.id, c.messages);
		report.messages.stored += stored;
		if (stored !== expected) {
			report.parityFailures.push(`${chat.id}: ${expected} messages converted, ${stored} stored`);
		}
	}

	const users = [...reports.values(), ...(orphan.conversations.in || orphan.files.in || orphan.tags.in ? [orphan] : [])];
	return { revision: source.revision, dryRun: Boolean(opts.dryRun), users };
}
