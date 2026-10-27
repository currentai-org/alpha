// Client-side conversation export to portable Markdown. No server round-trip — the
// transcript is serialized from message state already in the browser and downloaded as a
// local file, so nothing leaves the device (matches the privacy-first, guest-only stance).
// Deliberately mirrors exactly what the guest already sees: user + assistant turns and
// their cited open-web sources. It NEVER includes the system prompt / persona, file
// blobs, or internal metadata. The serializer is pure + DOM-free (unit-testable); only
// `downloadConversationMarkdown` touches the DOM.

import type { Message } from "$lib/chat/types/Message";
import { formatRagEngine } from "$lib/chat/utils/formatRagEngine";

export interface ExportableConversation {
	title?: string;
	model?: string;
	messages: Message[];
	/** Injectable for tests; defaults to now at call time. */
	exportedAt?: Date;
}

// YAML scalars: a JSON-quoted string is valid YAML and safely escapes ':' '#' quotes etc.
const yaml = (v: string): string => JSON.stringify(String(v));

const ymd = (d: Date): string =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Serialize a conversation to Markdown with a small YAML frontmatter header. Skips system
 * turns (persona), includes user/assistant content and an open sources list when present.
 */
export function conversationToMarkdown(conv: ExportableConversation): string {
	const title = conv.title?.trim() || "Untitled conversation";
	const date = ymd(conv.exportedAt ?? new Date());

	const front = [
		"---",
		`title: ${yaml(title)}`,
		...(conv.model ? [`model: ${yaml(conv.model)}`] : []),
		`exported: ${date}`,
		"source: AI Potluck (aipotluck.org)",
		"---",
		"",
		`# ${title}`,
		"",
	];

	const body: string[] = [];
	for (const m of conv.messages) {
		// Only the turns the guest sees. System/persona is never exported.
		if (m.from !== "user" && m.from !== "assistant") continue;
		const content = m.content?.trim() ?? "";
		const webSources = m.webSearch?.sources ?? [];
		const ragSources = m.rag?.sources ?? [];
		const vaultSynthesis = m.rag?.vaultSynthesis?.trim();
		if (!content && webSources.length === 0 && ragSources.length === 0 && !vaultSynthesis) continue;

		body.push(m.from === "user" ? "## You" : "## Assistant", "");
		if (content) body.push(content, "");
		if (webSources.length || ragSources.length) {
			body.push("**Sources**");
			for (const s of webSources) {
				const when = s.asOf ? ` (${s.asOf.slice(0, 10)})` : "";
				body.push(`- [${s.n}] ${s.title}${when} — ${s.url}`);
			}
			// RagSource.n is already the GLOBAL citation number (offset past web sources at merge
			// time — see rag/evidence.ts), so render it directly, exactly like the on-screen
			// SourceStrip/RagSourceStrip. Adding webSources.length here again would double-offset.
			for (const s of ragSources) {
				const when = m.rag?.asOf ? ` (${m.rag.asOf.slice(0, 10)})` : "";
				const link = s.url ? ` — ${s.url}` : "";
				// Attribute FEDERATED (SyftHub) sources by name so the export is honest about where the
				// grounding came from; catalog (Potluck) rows keep the original title-only format.
				const src = s.engine.startsWith("SyftHub") ? ` — ${formatRagEngine(s)}` : "";
				body.push(`- [${s.n}] ${s.title}${when}${link}${src}`);
			}
			body.push("");
		}
		if (vaultSynthesis) {
			body.push("**Federated synthesis (local-culture vault)**", "", vaultSynthesis, "");
		}
	}

	return (
		[...front, ...body]
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd() + "\n"
	);
}

/** Slugified, dated, sanitized filename. Falls back to "conversation" for untitled chats. */
export function exportFilename(title: string | undefined, date = new Date()): string {
	const slug =
		(title ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "conversation";
	return `aipotluck.org-${slug}-${ymd(date)}.md`;
}

/**
 * Browser-only: build the Markdown and trigger a client-side download. No-op (and safe)
 * during SSR/tests where `document` is absent. Nothing is sent anywhere.
 */
export function downloadConversationMarkdown(conv: ExportableConversation): void {
	if (typeof document === "undefined") return;
	const md = conversationToMarkdown(conv);
	const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = exportFilename(conv.title, conv.exportedAt);
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
