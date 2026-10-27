// The configured MCP servers' router lane, and the read-aloud intent test. Read-aloud speaks
// through Kokoro (`readAloudClip` in ./index.ts, CUR-3989).
import { config } from "$lib/chat/server/config";
import { createOpenAIClient } from "$lib/chat/server/openaiClient";
import { defaultModel } from "$lib/chat/server/models";
import { resolveClassifierLane } from "$lib/chat/server/endpoints/openai/providerPin";

// read/repeat/say/speak/play X aloud · out loud · back · to me · text-to-speech · tts · narrate ·
// voice this · "speak this" · "repeat the previous answer". A no-cue match needs a TTS-specific verb
// (`speak`) or an explicit prior-answer reference; everything else must carry an aloud/voice cue, so
// "say that again" or "read the following passage and summarize" stay ordinary turns.
const READ_ALOUD_INTENT =
	/\b(read|repeat|say|speak|play|narrate)\b[^.?!]{0,40}\b(aloud|out loud|back|to me)\b|\bspeak\s+(this|it|that)\b|\b(read|repeat|say|speak)\s+the\s+(?:previous|last|above)(?:\s+(?:answer|response|message))?\b|\btext[-\s]?to[-\s]?speech\b|\btts\b|\bnarrate\b|\bvoice this\b/i;

/** Whether the message reads as a request to speak text aloud (TTS). The single source for "this is a
 *  read-aloud turn", reused by textGeneration to fire the TTS in PARALLEL with generation and hold its
 *  audio until the model's willingness verdict. */
export function isReadAloudIntent(text: string): boolean {
	return !!text && READ_ALOUD_INTENT.test(text);
}

/** The router's lane: dedicated MCP_ROUTER_* first, then the chat lane, host, key and wire id resolved
 *  together. Shared with the configured servers' router loop (CUR-3026). */
export async function routerLane(): Promise<{
	client: Awaited<ReturnType<typeof createOpenAIClient>>;
	model: string;
}> {
	const cfg = (k: string): string | undefined => {
		const v = Reflect.get(config, k);
		return typeof v === "string" && v.trim() ? v.trim() : undefined;
	};
	const lane = resolveClassifierLane(defaultModel, cfg("OPENAI_BASE_URL"), cfg("OPENAI_PROVIDER"));
	const baseURL = cfg("MCP_ROUTER_BASE_URL") ?? lane.baseURL ?? "";
	const apiKey =
		cfg("MCP_ROUTER_API_KEY") ?? lane.apiKey ?? cfg("OPENAI_API_KEY") ?? cfg("HF_TOKEN") ?? "sk-";
	const model = cfg("MCP_ROUTER_MODEL") ?? lane.modelId;
	const client = await createOpenAIClient({
		baseURL,
		apiKey,
		// A router call blocks the turn the same way the arithmetic classifier does, and
		// carries the same fail-open `catch` that a hang walks straight past. Same 8s as the other two
		// classifier lanes (searchDecision.ts, forcedToolCallLane.ts) against the same gateway. (CUR-1345)
		timeout: 8_000,
		defaultHeaders: { "User-Agent": "aipotluck.org" },
	});
	return { client, model };
}
