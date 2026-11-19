/**
 * The import's parity report: per person, what the source held and what Alpha holds now.
 */
export interface UserReport {
	/** The Open WebUI user id. */
	sourceId: string;
	email: string;
	/** Whether Open WebUI stored a subject id for the chosen provider. */
	subjectId: boolean;
	account: string;
	accountNote: string | null;
	conversations: {
		in: number;
		imported: number;
		updated: number;
		unchanged: number;
		skipped: { id: string; reason: string }[];
	};
	messages: { in: number; skipped: number; stored: number };
	messageSkips: { chatId: string; messageId: string; reason: string }[];
	/** Files a message carried that it holds no reference to. The message itself imported; this is not a parity failure. */
	attachmentSkips: { chatId: string; messageId: string; fileId: string; reason: string }[];
	/** Uploaded files: each is imported, already stored (unchanged), or skipped with a reason. */
	files: {
		in: number;
		imported: number;
		unchanged: number;
		skipped: { id: string; reason: string }[];
		/** Text sidecars written this run. */
		sidecars: number;
		/** Files stored without a sidecar, and why. Not a parity failure: the file itself is there. */
		sidecarNotes: { id: string; reason: string }[];
	};
	/** The person's tag rows: each is stored (new or already there) or skipped with a reason. */
	tags: { in: number; stored: number; skipped: { id: string; reason: string }[] };
	droppedBlocks: number;
	parityFailures: string[];
	/** Why this person's chats were refused rather than written, while this deployment seals history and
	 *  they have no history key. Each refused chat is also in `conversations.skipped`. */
	sealRefused?: string;
}

export interface ImportReport {
	revision: string;
	dryRun: boolean;
	users: UserReport[];
}

/** In equals out: every conversation and message is stored, unchanged, or skipped with a reason. */
export function userParity(u: UserReport): boolean {
	const c = u.conversations;
	return (
		c.in === c.imported + c.updated + c.unchanged + c.skipped.length &&
		u.messages.in === u.messages.skipped + u.messages.stored &&
		u.files.in === u.files.imported + u.files.unchanged + u.files.skipped.length &&
		u.tags.in === u.tags.stored + u.tags.skipped.length &&
		u.parityFailures.length === 0
	);
}

export const reportParity = (r: ImportReport): boolean => r.users.every(userParity);

/** Whether any person's chats were refused for want of a history key to seal them to. */
export const reportSealRefused = (r: ImportReport): boolean => r.users.some((u) => u.sealRefused);

export function formatReport(r: ImportReport): string {
	const out: string[] = [`Open WebUI revision ${r.revision}${r.dryRun ? " (dry run: nothing was written)" : ""}`, ""];
	for (const u of r.users) {
		const c = u.conversations;
		out.push(`${u.email || u.sourceId}  [${u.account}${u.subjectId ? ", subject id" : ", no subject id"}]  ${userParity(u) ? "PARITY" : "MISMATCH"}`);
		out.push(
			`  conversations: ${c.in} in, ${c.imported} imported, ${c.updated} updated, ${c.unchanged} unchanged, ${c.skipped.length} skipped`
		);
		out.push(`  messages:      ${u.messages.in} in, ${u.messages.stored} stored, ${u.messages.skipped} skipped`);
		if (u.files.in) {
			out.push(
				`  files:         ${u.files.in} in, ${u.files.imported} imported, ${u.files.unchanged} unchanged, ${u.files.skipped.length} skipped, ${u.files.sidecars} text sidecars written`
			);
		}
		if (u.tags.in) out.push(`  tags:          ${u.tags.in} in, ${u.tags.stored} stored, ${u.tags.skipped.length} skipped`);
		if (u.sealRefused) out.push(`  REFUSED: chats not imported: ${u.sealRefused}`);
		if (u.droppedBlocks) out.push(`  ${u.droppedBlocks} non-text content blocks were left out of message text`);
		for (const s of c.skipped) out.push(`  skipped conversation ${s.id}: ${s.reason}`);
		for (const s of u.messageSkips) out.push(`  skipped message ${s.messageId} (chat ${s.chatId}): ${s.reason}`);
		for (const s of u.attachmentSkips) out.push(`  message ${s.messageId} (chat ${s.chatId}) imported without file ${s.fileId}: ${s.reason}`);
		for (const s of u.files.skipped) out.push(`  skipped file ${s.id}: ${s.reason}`);
		for (const s of u.tags.skipped) out.push(`  skipped tag ${s.id}: ${s.reason}`);
		for (const s of u.files.sidecarNotes) out.push(`  file ${s.id} stored without a text sidecar: ${s.reason}`);
		for (const f of u.parityFailures) out.push(`  parity failure ${f}`);
	}
	const sum = (pick: (u: UserReport) => number) => r.users.reduce((n, u) => n + pick(u), 0);
	out.push(
		"",
		`total: ${r.users.length} users, ${sum((u) => u.conversations.in)} conversations in, ${sum((u) => u.conversations.imported + u.conversations.updated + u.conversations.unchanged)} present, ${sum((u) => u.messages.in)} messages in, ${sum((u) => u.messages.stored)} stored, ${sum((u) => u.files.in)} files in, ${sum((u) => u.files.imported + u.files.unchanged)} present`,
		reportParity(r) ? "parity: OK" : "parity: MISMATCH",
		...(reportSealRefused(r) ? ["sealing: REFUSED for the people marked above; nothing of theirs was written"] : []),
		"not imported by this version: folders, shares, knowledge, memories, models"
	);
	return out.join("\n");
}

/** A report for one Open WebUI user with every count at zero. */
export function emptyUserReport(sourceId: string, email: string): UserReport {
	return {
		sourceId,
		email,
		subjectId: false,
		account: "none",
		accountNote: null,
		conversations: { in: 0, imported: 0, updated: 0, unchanged: 0, skipped: [] },
		messages: { in: 0, skipped: 0, stored: 0 },
		messageSkips: [],
		attachmentSkips: [],
		files: { in: 0, imported: 0, unchanged: 0, skipped: [], sidecars: 0, sidecarNotes: [] },
		tags: { in: 0, stored: 0, skipped: [] },
		droppedBlocks: 0,
		parityFailures: [],
	};
}
