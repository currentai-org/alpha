// The turn owner's own connectors on an agent turn. Chosen here, from the signed-in session alone, with the
// same owner-scoped function a chat turn uses (googleServerFor), never from the request body or the
// `x-agent-subject` header. Each goes in the /run body as `{name, url, headers}`, where the headers carry
// only a short-lived access token: the refresh token and the sealing key stay in this server. The agent
// service keeps the list in the task's memory and hands it to its model gateway, which relays the engine's
// calls with the token swapped in, so the token never reaches the sandbox (agent-service/api/mcp_relay.py).
import { googleServerFor } from "$lib/chat/server/connectors/google";

/** One connector as /run takes it. */
export type AgentConnector = { name: string; url: string; headers: Record<string, string> };

export type AgentConnectorDeps = {
	/** The `google_connector_stub` fault: Google is answered by its stand-in (googleE2eStub.ts). */
	googleStub?: boolean;
	googleFor?: typeof googleServerFor;
};

/**
 * The connectors this person has connected, as /run takes them. Empty for a guest, with the
 * `google-connector` flag off, or with nothing connected, and then the /run body is what it always was.
 */
export async function agentConnectorsFor(
	locals: App.Locals | undefined,
	deps: AgentConnectorDeps = {}
): Promise<AgentConnector[]> {
	const google = await (deps.googleFor ?? googleServerFor)(locals, {}, deps.googleStub ? "google_connector_stub" : null);
	return google ? [{ name: google.name, url: google.url, headers: { ...google.headers } }] : [];
}
