import { logger } from "$lib/chat/server/logger";
import { makeImageProcessor } from "../images";
import type { EndpointMessage } from "../types";

// The photos attached in this conversation, sent with an agent run so the agent can see them. Without
// them, a photo question asked with Agent set to On would reach an agent that has only the text.
//
// The bytes are the ones the turn already read through chat's storage layer and screened:
// preprocessMessages puts every retained image on its user message as base64 source bytes, whichever
// store the deployment keeps attachments in. So the agent reads nothing from storage itself, and a
// self-hosted install sends the same request as the hosted one.
//
// Each photo goes twice: the whole file, which agent-service copies into the workdir for the agent's
// tools, and a rendition sized for a model, which rides the prompt as image input. The rendition uses the
// limits the chat endpoint gives a model by default (endpointOai.ts's `multimodal.image`).

/** agent-service's caps (app.py ATTACHMENT_MAX_BYTES / ATTACHMENT_TOTAL_MAX_BYTES). A file past them is
 *  left out rather than failing the run with a 413. */
const AGENT_ATTACHMENT_MAX_BYTES = 10 * 1000 * 1000;
const AGENT_ATTACHMENT_TOTAL_MAX_BYTES = 40 * 1000 * 1000;

const forModel = makeImageProcessor({
	supportedMimeTypes: ["image/png", "image/jpeg"],
	preferredMimeType: "image/jpeg",
	maxSizeInMB: 1,
	maxWidth: 1024,
	maxHeight: 1024,
});

/** One entry of agent-service's `RunRequest.files`. */
export type AgentRunFile = {
	name: string;
	mime: string;
	data: string;
	image?: { mime: string; data: string };
};

/** Every distinct image attached in the conversation, newest kept first when the total is over the cap, in
 *  conversation order. A photo the model rendition cannot be made from still goes, without `image`. */
export async function agentRunFiles(messages: EndpointMessage[]): Promise<AgentRunFile[]> {
	const images = messages
		.filter((m) => m.from === "user")
		.flatMap((m) => m.files ?? [])
		.filter((f) => f.type === "base64" && f.mime.startsWith("image/"));
	const seen = new Set<string>();
	const kept: typeof images = [];
	let total = 0;
	for (let i = images.length - 1; i >= 0; i--) {
		const f = images[i];
		if (seen.has(f.value)) continue;
		seen.add(f.value);
		const bytes = Buffer.byteLength(f.value, "base64");
		if (bytes > AGENT_ATTACHMENT_MAX_BYTES || total + bytes > AGENT_ATTACHMENT_TOTAL_MAX_BYTES) {
			logger.info({ bytes }, "[agent] an attached image is over agent-service's cap and is not sent");
			continue;
		}
		total += bytes;
		kept.unshift(f);
	}
	return Promise.all(
		kept.map(async (f): Promise<AgentRunFile> => {
			const file: AgentRunFile = { name: f.name, mime: f.mime, data: f.value };
			try {
				const { image, mime } = await forModel(f);
				file.image = { mime, data: image.toString("base64") };
			} catch (err) {
				logger.warn({ err: (err as Error)?.message }, "[agent] no model rendition for an attached image");
			}
			return file;
		})
	);
}
