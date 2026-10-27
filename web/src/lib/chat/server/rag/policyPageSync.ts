// Keeps the chat's answers about safety, privacy and terms in step with the pages legal reviewed
// (CUR-3105). A corpus holding a stale upload of a page would answer from text the site no longer
// shows, so the privacy, terms and safety copy is re-synced from the published page.
//
// Trigger: Payload's publish hook already POSTs every published page change to
// /api/cms/invalidate, which calls `syncPolicyPage` for the paths below and reads the page back
// over Payload's REST API (Payload's code belongs to the CMS vendor and stays untouched).
//
// Swap order is create → activate → retire, so a failure part-way leaves two active copies for a
// moment rather than none. Each run retires only active copies OLDER than its own, so two publishes
// racing each other settle on the newest.

import { createHash } from "crypto";
import { cmsPage } from "$lib/website.server";
import type { LexicalNode } from "$lib/lexical/types";
import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";
import { chunkDocumentText } from "./chunking";
import {
	RagConflictError,
	activateRagDocument,
	createRagDocument,
	listRagDocuments,
	retireRagDocument,
	updateRagDocument,
	type RagDocumentListItem,
} from "./adminWrites";

const POLICY_PAGE_PATHS = ["/trust-and-safety", "/privacy-notice", "/terms-of-use"] as const;
export type PolicyPagePath = (typeof POLICY_PAGE_PATHS)[number];

export function isPolicyPagePath(path: unknown): path is PolicyPagePath {
	return typeof path === "string" && (POLICY_PAGE_PATHS as readonly string[]).includes(path);
}

// Uploads that predate this sync, matched by their exact declared source and an empty url. They are
// retired the first time their page syncs.
const LEGACY_SOURCES: Partial<Record<PolicyPagePath, string[]>> = {
	"/trust-and-safety": ["trust-and-safety.md.txt"],
};

// No user made the change. created_by and approved_by reference users(id), so the sync writes null;
// its rows are told apart by source_type "cms-page".
const SYNC_ACTOR = null;
const SOURCE_TYPE = "cms-page";

function inlineText(node: LexicalNode): string {
	if (node.type === "text") return node.text ?? "";
	if (node.type === "linebreak") return " ";
	return (node.children ?? []).map(inlineText).join("");
}

function blockLines(node: LexicalNode): string[] {
	switch (node.type) {
		case "heading":
		case "paragraph":
		case "quote": {
			const text = inlineText(node).replace(/\s+/g, " ").trim();
			return text ? [text] : [];
		}
		case "list":
			return (node.children ?? []).flatMap((item) => {
				const own = (item.children ?? []).filter((c) => c.type !== "list");
				const nested = (item.children ?? []).filter((c) => c.type === "list");
				const text = own.map(inlineText).join("").replace(/\s+/g, " ").trim();
				return [...(text ? [`- ${text}`] : []), ...nested.flatMap(blockLines)];
			});
		case "table":
			return (node.children ?? []).map((row) =>
				(row.children ?? [])
					.map((cell) => inlineText(cell).replace(/\s+/g, " ").trim())
					.join(" | ")
			);
		default:
			return (node.children ?? []).flatMap(blockLines);
	}
}

/** Render a page's Lexical body as plain text, one block per paragraph (`\n\n`), so the chunker can
 *  split on block boundaries. Headings stand on their own line, list items read `- item`, and a table
 *  row reads `cell | cell`. */
export function lexicalToParagraphs(root: { root: { children: LexicalNode[] } } | null | undefined): string {
	if (!root?.root?.children) return "";
	return root.root.children
		.flatMap(blockLines)
		.filter((line) => line.length > 0)
		.join("\n\n");
}

function textHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The `source` field carries the rendered text's hash, so an unchanged republish (a meta or
 *  breadcrumb edit) costs no embedding call and leaves the corpus alone. */
export function sourceFor(path: PolicyPagePath, text: string): string {
	return `cms:${path}#${textHash(text)}`;
}

type PolicySyncResult =
	| { outcome: "unchanged"; documentId: string }
	| { outcome: "replaced"; documentId: string; retired: string[]; chunks: number }
	| { outcome: "skipped"; reason: string };

export type PolicySyncDeps = {
	fetchPage: (path: PolicyPagePath) => Promise<{ title: string; text: string } | null>;
	list: () => Promise<RagDocumentListItem[]>;
	create: typeof createRagDocument;
	activate: typeof activateRagDocument;
	retire: typeof retireRagDocument;
	update: typeof updateRagDocument;
	origin: () => string;
};

const liveDeps: PolicySyncDeps = {
	fetchPage: async (path) => {
		const page = await cmsPage(fetch, path.split("/").filter(Boolean));
		if (!page) return null;
		return {
			title: page.title,
			text: lexicalToParagraphs(page.content as { root: { children: LexicalNode[] } } | null),
		};
	},
	list: listRagDocuments,
	create: createRagDocument,
	activate: activateRagDocument,
	retire: retireRagDocument,
	update: updateRagDocument,
	origin: () => (config.PUBLIC_ORIGIN || "https://www.aipotluck.org").replace(/\/+$/, ""),
};

function pathOf(url: string | null): string | null {
	if (!url) return null;
	try {
		return new URL(url).pathname.replace(/\/+$/, "") || "/";
	} catch {
		return null;
	}
}

function ownedBy(doc: RagDocumentListItem, path: PolicyPagePath): boolean {
	if (pathOf(doc.url) === path) return true;
	return !doc.url && (LEGACY_SOURCES[path] ?? []).includes(doc.source);
}

/** Sync one published policy page into the chat's corpus. Never throws for an expected miss (page
 *  gone, empty body): it returns `skipped` with the reason, and the caller logs it. */
export async function syncPolicyPage(
	path: PolicyPagePath,
	deps: PolicySyncDeps = liveDeps
): Promise<PolicySyncResult> {
	const page = await deps.fetchPage(path);
	if (!page) return { outcome: "skipped", reason: "no published page at this path" };
	if (!page.text.trim()) return { outcome: "skipped", reason: "page body rendered empty" };

	const source = sourceFor(path, page.text);
	const owned = (await deps.list()).filter((d) => ownedBy(d, path));
	const current = owned.find((d) => d.status === "active" && d.source === source);
	if (current && !owned.some((d) => d.status === "active" && d.id !== current.id)) {
		return { outcome: "unchanged", documentId: current.id };
	}

	let fresh;
	if (current) {
		fresh = current;
	} else {
		const { doc } = await deps.create(
			{
				title: page.title,
				text: page.text,
				source,
				url: `${deps.origin()}${path}`,
				sourceType: SOURCE_TYPE,
				// The pages print their own "Last updated" line, which lands in the text.
				sourceDate: null,
			},
			SYNC_ACTOR
		);
		fresh = await deps.activate(doc.id, doc.version, SYNC_ACTOR);
	}

	// Retire every other active copy of this page that is older than ours.
	const retired: string[] = [];
	const after = (await deps.list()).filter((d) => ownedBy(d, path));
	for (const old of after) {
		if (old.id === fresh.id || old.status !== "active") continue;
		if ((old.createdAt?.getTime() ?? 0) > (fresh.createdAt?.getTime() ?? 0)) continue;
		try {
			const row = await deps.retire(old.id, old.version, SYNC_ACTOR);
			if (!old.title.startsWith("OLD-")) {
				await deps.update(old.id, { title: `OLD-${old.title}` }, row.version, SYNC_ACTOR);
			}
			retired.push(old.id);
		} catch (err) {
			// Another run retired it first.
			if (!(err instanceof RagConflictError)) throw err;
		}
	}
	return {
		outcome: "replaced",
		documentId: fresh.id,
		retired,
		chunks: chunkDocumentText(page.text).length,
	};
}

/** Fire-and-log wrapper for the publish hook: one line per run, success or failure. */
export async function syncPolicyPageLogged(path: PolicyPagePath): Promise<void> {
	const t0 = Date.now();
	try {
		const result = await syncPolicyPage(path);
		logger.info({ path, ...result, ms: Date.now() - t0 }, "[rag] policy page sync");
	} catch (err) {
		logger.error({ path, err: String(err), ms: Date.now() - t0 }, "[rag] policy page sync failed");
	}
}
