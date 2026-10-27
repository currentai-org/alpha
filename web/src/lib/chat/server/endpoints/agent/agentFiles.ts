import mimeTypes from "mime-types";
import type { MessageFile } from "$lib/chat/types/Message";
import type { AgentArtifact } from "./endpointAgent";

// The files an agent turn wrote (CUR-4398), copied out of agent-service's session workdir while it still
// holds them. The workdir sits in the machine's /tmp, so a deploy, a machine stop or the idle reaper
// erases it, so a download link that reads it live stops working within hours. The copy is stored
// with the conversation the way a chat attachment is (storeChatAttachments): My files for a person the
// bucket keeps files for, the files table otherwise, and delete-all, deleting the chat and the export
// already cover both.

/** The largest single file saved. A bigger one stays reachable only through the live workdir link. */
const AGENT_FILE_SAVE_MAX_BYTES = 10 * 1024 * 1024;
/** The most one turn saves in total, so a runaway agent cannot fill a person's My files in one turn. */
const AGENT_FILE_SAVE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export type SavedAgentFile = { agentPath: string; ref: MessageFile };

/**
 * Saves a turn's artifacts and returns each saved one with its reference, in artifact order. A file's
 * bytes are its inlined text when the done frame carried it whole, else `read` fetches them from the
 * workdir. A file over the caps, or one `read` cannot get, is skipped and keeps only the live link.
 * @throws what `save` throws (a signed-in person's full My files, StorageQuotaExceededError).
 */
export async function keepAgentFiles(
	artifacts: readonly AgentArtifact[],
	deps: {
		read: (agentPath: string) => Promise<Uint8Array | undefined>;
		save: (files: File[]) => Promise<MessageFile[]>;
	}
): Promise<SavedAgentFile[]> {
	const files: File[] = [];
	const paths: string[] = [];
	let total = 0;
	for (const a of artifacts) {
		const agentPath = (a.name ?? "").trim();
		if (!agentPath) continue;
		// The declared size skips a fetch that could only be refused.
		const declared = typeof a.bytes === "number" && a.bytes >= 0 ? a.bytes : 0;
		if (declared > AGENT_FILE_SAVE_MAX_BYTES || total + declared > AGENT_FILE_SAVE_MAX_TOTAL_BYTES) continue;
		const whole = typeof a.text === "string" && a.truncated !== true;
		const bytes = whole ? new TextEncoder().encode(a.text as string) : await deps.read(agentPath).catch(() => undefined);
		if (!bytes || bytes.byteLength > AGENT_FILE_SAVE_MAX_BYTES || total + bytes.byteLength > AGENT_FILE_SAVE_MAX_TOTAL_BYTES)
			continue;
		total += bytes.byteLength;
		const name = agentPath.split("/").pop() || agentPath;
		files.push(new File([new Uint8Array(bytes)], name, { type: mimeTypes.lookup(name) || "application/octet-stream" }));
		paths.push(agentPath);
	}
	if (files.length === 0) return [];
	const refs = await deps.save(files);
	// Paths pair with references by position, so a save that answered with any other count pairs none.
	if (refs.length !== files.length) return [];
	return refs.map((ref, i) => ({ agentPath: paths[i], ref: { ...ref, agentPath: paths[i] } }));
}
