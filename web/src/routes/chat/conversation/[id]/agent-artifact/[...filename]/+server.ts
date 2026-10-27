import { error } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { agentArtifactDownloadEnabled } from "$lib/chat/server/agentArtifactDownload";
import { agentServiceUrl, agentServiceToken } from "$lib/chat/server/agentMode";
import { agentServiceHeaders } from "$lib/chat/server/endpoints/agent/endpointAgent";
import { loadOwnedConversation } from "$lib/chat/server/loadOwnedConversation";
import { collections } from "$lib/chat/server/database";
import {
	fakeAgentAllowed,
	fakeAgentArtifact,
	isFakeAgentTaskId,
} from "$lib/chat/server/endpoints/agent/fakeAgentService";
import type { ObjectId } from "bson";
import { logger } from "$lib/chat/server/logger";
import { hasUnsafePathSegment } from "$lib/chat/server/pathSafety";
import mimeTypes from "mime-types";
import { downloadFile } from "$lib/chat/server/files/downloadFile";

// Proxies a file an agent turn produced (CUR-546) out of agent-service's still-alive session
// workdir (CUR-196) — the server round-trip renderArtifacts() links to once a turn completes.
// Same threat model as the sibling `output/[sha256]` route (arbitrary agent-authored bytes served
// same-origin), same CSP, but an entirely different data path: a proxied agent-service fetch, not
// a Postgres blob read. There is no separate retention mechanism here — the file's survival is
// already governed by agent-service's session-idle reaper; this route just exposes it.
const CSP = "default-src 'none'; script-src 'none'; style-src 'none'; sandbox;";

function contentDisposition(filename: string): string {
	// ASCII fallback for clients that don't read filename* (RFC 6266), real UTF-8 name alongside it
	// — CUR-571 means real agent-chosen filenames (spaces, unicode) are now in play.
	const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const GET: RequestHandler = async ({ locals, params, url }) => {
	// Flag check FIRST, same posture as the sibling route: a flag-off feature is a stated policy
	// ("not available"), not an absent resource — 403 says "closed," 404 would ambiguously also
	// mean "never existed," which is the distinction that keeps a crafted request from probing
	// behavior while the flag is off.
	if (!agentArtifactDownloadEnabled()) {
		error(403, "Agent file download is disabled.");
	}

	const convId = await loadOwnedConversation(locals, params.id);

	const filename = z.string().min(1).parse(params.filename);

	// Path-traversal guard. SvelteKit decodes the `[...filename]` rest param BEFORE this handler ever
	// sees it, so a request for `%2e%2e/%2e%2e/<other-conversation-id>/artifacts/<file>` arrives here
	// as literal `..` segments — and `encodeURIComponent` does not escape periods, so those survive
	// straight into the URL string below, where `fetch`'s own URL parser then collapses them, letting
	// the outbound request resolve against a DIFFERENT session id than the one `authCondition` above
	// just checked ownership of. Reject any empty, `.`, or `..` segment before it can reach that
	// string — the ownership check only validated `convId`; this is what keeps the path built from it
	// honest. See pathSafety.spec.ts for the case-by-case proof.
	if (hasUnsafePathSegment(filename)) {
		error(400, "Invalid filename.");
	}

	// The copy the turn saved with the conversation outlives the workdir, so it answers first.
	// The link names that copy by hash; a link without one is a file its turn did not save, and it goes
	// to the workdir rather than to another turn's copy of the same path. (CUR-4398)
	const savedSha = url.searchParams.get("saved");
	const saved = savedSha ? await savedArtifactBytes(convId, filename, savedSha) : undefined;
	if (saved) return artifactResponse(new Response(new Uint8Array(saved)), filename);

	const fakeBytes = await fakeArtifactBytes(convId, filename);
	if (fakeBytes !== undefined) {
		if (fakeBytes === null) error(404, GONE);
		return artifactResponse(new Response(fakeBytes), filename);
	}

	const baseURL = agentServiceUrl();
	if (!baseURL) {
		// Flag ON but AGENT_SERVICE_URL unset is the same class of loud misconfiguration
		// agentModeEnabled() guards elsewhere — log it, but don't leak internal config state to the
		// response; from the caller's side this is indistinguishable from "not available".
		logger.warn(
			"[agent-artifact] agent-artifact-download flag is ON but AGENT_SERVICE_URL is unset"
		);
		error(404, GONE);
	}

	const token = agentServiceToken();
	// Same derivation endpointAgent.ts used for the turn that created this session — a different one
	// means agent-service's get_session_workdir, keyed on this exact principal, finds nothing.
	const headers = agentServiceHeaders(token, locals);

	const encodedPath = filename
		.split("/")
		.map((seg) => encodeURIComponent(seg))
		.join("/");

	const upstream = await fetch(
		`${baseURL.replace(/\/$/, "")}/sessions/${convId.toString()}/artifacts/${encodedPath}`,
		{ headers, signal: AbortSignal.timeout(30_000) }
	);

	if (!upstream.ok || !upstream.body) {
		// Don't forward agent-service's raw error body — this is a stated policy ("available while
		// this conversation stays active"), not a diagnostic surface.
		error(404, GONE);
	}

	return artifactResponse(upstream, filename);
};

const GONE = "This file isn't available anymore — it's only kept while this conversation stays active.";

/**
 * The bytes of the copy an agent turn saved for `filename` with hash `sha`, read where the
 * conversation's other files are read. Undefined when the conversation holds no such reference, or when
 * the stored copy cannot be read; the live workdir is asked next either way. (CUR-4398)
 */
async function savedArtifactBytes(
	convId: ObjectId,
	filename: string,
	sha: string
): Promise<Buffer | undefined> {
	const conv = await collections.conversations.findOne({ _id: convId });
	if (!conv) return undefined;
	const ref = conv.messages
		.flatMap((m) => m.files ?? [])
		.find((f) => f.agentPath === filename && f.value === sha);
	if (!ref) return undefined;
	try {
		const file = await downloadFile(ref.value, convId, {
			ownerId: conv.userId?.toString(),
			guestSessionId: conv.userId ? conv.formerGuestSessionId : conv.sessionId,
			name: ref.name,
			mime: ref.mime,
			location: ref.location,
		});
		return Buffer.from(file.value, "base64");
	} catch (e) {
		logger.warn(
			{ conversationId: convId.toString(), err: e instanceof Error ? e.name : String(e) },
			"[agent-artifact] saved copy unreadable, asking the live workdir"
		);
		return undefined;
	}
}

/**
 * A file a scenario run's stand-in agent wrote (fakeAgentService.ts), found by the fake task id
 * on this conversation's newest agent turn. `undefined` when there is no such turn, or on production,
 * where the stand-in never runs and this costs no read; `null` when there is one but it wrote no file
 * by that name. (SOL-212)
 */
async function fakeArtifactBytes(convId: ObjectId, filename: string): Promise<string | null | undefined> {
	if (!fakeAgentAllowed()) return undefined;
	const conv = await collections.conversations.findOne({ _id: convId });
	const taskId = (conv?.messages ?? [])
		.map((m) => m.agentRun?.taskId)
		.filter(isFakeAgentTaskId)
		.at(-1);
	if (!taskId) return undefined;
	return fakeAgentArtifact(taskId, filename);
}

function artifactResponse(upstream: Response, filename: string): Response {
	// Content-Type/Content-Disposition are reconstructed from the known, locally-sanitized filename
	// (the route param), not trusted from agent-service's response headers verbatim.
	const basename = filename.split("/").pop() ?? filename;
	const contentType = mimeTypes.lookup(basename) || "application/octet-stream";
	const contentLength = upstream.headers.get("content-length");

	return new Response(upstream.body, {
		headers: {
			"Content-Type": contentType,
			"Content-Security-Policy": CSP,
			"Content-Disposition": contentDisposition(basename),
			...(contentLength ? { "Content-Length": contentLength } : {}),
		},
	});
}
