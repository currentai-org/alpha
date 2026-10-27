// read-aloud's voice is Kokoro (Apache-2.0) served through Hugging Face's inference router
// with DeepInfra pinned as the provider, one voice per language (KOKORO_VOICES in readAloudLanguage.ts).
// Kokoro pronounces a text by its voice's language, so a French answer read by the French voice gets
// French pronunciation. Kokoro replaces an English-only model that ignored the language
// it was sent (CUR-3151).
//
// Nothing is stored. The turn hands the client a same-origin URL whose last segment is the text, its
// language and its conversation, sealed (AES-GCM) so the text never appears in a URL or an access log.
// The speech route opens it and synthesizes when the player fetches the clip, and only for whoever owns
// that conversation: every fetch is a billed synthesis, so a copied URL must not be a ticket to one. DeepInfra keeps neither the text
// nor the audio (deepinfra.com/docs/data). (CUR-3989)
import { CHAT_API_PATH } from "$lib/chat/paths";
import { config } from "$lib/chat/server/config";
import { firstKey } from "$lib/chat/server/env/firstKey";
import { open, seal } from "$lib/chat/server/storage/locations/sealedSecret";
import { marked, type Token, type Tokens } from "marked";
import { READ_ALOUD_TOOL } from "$lib/chat/readAloudTool";
import { kokoroVoice } from "./readAloudLanguage";

const SPEECH_MODEL = "hexgrad/Kokoro-82M";
/** The component a read-aloud clip credits in the provenance trace. */
export const SPEECH_COMPONENT = `https://huggingface.co/${SPEECH_MODEL}`;
/** The tool name a read-aloud clip records on the message. */
export const SPEECH_TOOL = READ_ALOUD_TOOL;
const ROUTER_SPEECH_URL = "https://router.huggingface.co/deepinfra/v1/openai/audio/speech";
const SEAL_INFO = "aipotluck/read-aloud-clip/v1";
// A reserved path (paths.ts), served in place on both surfaces, so a clip URL already saved in a
// conversation keeps working wherever it is read back.
const CLIP_PATH = `${CHAT_API_PATH}/speech/`;

export type SpeechClip = { text: string; language: string; conversation: string };

function sealSecret(): string {
	const secret = config.BETTER_AUTH_SECRET;
	if (!secret) throw new Error("BETTER_AUTH_SECRET is not configured, so a read-aloud clip cannot be sealed");
	return secret;
}

/** The URL the player fetches for `clip`. Ends in `.mp3` so the media helpers treat it as audio. */
export function speechClipUrl(clip: SpeechClip): string {
	const token = seal(
		JSON.stringify({ t: clip.text, l: clip.language, c: clip.conversation }),
		sealSecret(),
		SEAL_INFO
	);
	return `${CLIP_PATH}${token}.mp3`;
}

/** The clip a URL's last segment names, or null when it was not sealed by this environment. */
export function openSpeechClip(segment: string): SpeechClip | null {
	try {
		const { t, l, c } = JSON.parse(open(segment.replace(/\.mp3$/, ""), sealSecret(), SEAL_INFO));
		return typeof t === "string" && typeof l === "string" && typeof c === "string" && t && c
			? { text: t, language: l, conversation: c }
			: null;
	} catch {
		return null;
	}
}

/** An answer's Markdown as the words a listener should hear. The voice reads markup literally ("asterisque" for every bold word in a French answer). Code blocks and raw HTML
 *  are dropped; each block ends on a line break so the voice pauses between them. */
export function speakableText(markdown: string): string {
	const words = (tokens: Token[]): string =>
		tokens
			.map((t) => {
				if (t.type === "code" || t.type === "html" || t.type === "hr" || t.type === "space") return "";
				if (t.type === "list") return (t as Tokens.List).items.map((i) => words(i.tokens)).join("\n");
				if (t.type === "table") {
					const table = t as Tokens.Table;
					return [table.header, ...table.rows]
						.map((row) => row.map((cell) => words(cell.tokens)).join(", "))
						.join("\n");
				}
				if ("tokens" in t && t.tokens) return words(t.tokens);
				return "text" in t ? (t.text as string) : "";
			})
			.join("");
	const blocks = marked.lexer(markdown).map((t) => words([t]).replace(EMOJI, "").trim());
	return blocks
		.filter(Boolean)
		.join("\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/** Emoji and the pieces that join them (variation selector, joiner, skin tone, flag letters, keycap and
 *  subdivision tags). A voice reads an emoji as a sound, a laugh for 😂 (CUR-3987). Digits, `#` and
 *  `*` are emoji only with a following keycap mark, so the mark goes and the character stays. */
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200D|\uFE0F|\u20E3|[\u{E0020}-\u{E007F}]/gu;

/** Whether the router credential read-aloud needs is set. Config, not a switch: the `read-aloud` flag
 *  decides whether the feature is on (readAloudGate.ts), and this says whether it can run once it is. */
export function speechConfigured(): boolean {
	return firstKey(["HF_TOKEN"], "readAloudToken") !== "";
}

/** Synthesize `clip` as MP3. The caller reads `ok` and the body. A clip in a language Kokoro has no
 *  voice for throws: the turn refuses such a language before it hands out a URL, so reaching here means
 *  a clip sealed by an older build, and reading it in another language's voice is the bug CUR-3989 fixed. */
export function synthesizeSpeech(clip: SpeechClip, signal?: AbortSignal): Promise<Response> {
	const voice = kokoroVoice(clip.language);
	if (!voice) return Promise.reject(new Error(`read-aloud has no voice for language "${clip.language}"`));
	const token = firstKey(["HF_TOKEN"], "readAloudToken");
	// The token's inference permission is granted on behalf of the org, so the router 403s without it
	// (the same header transcribe/+server.ts sends).
	const billTo = firstKey(["HF_BILL_TO"], "readAloudBillTo", { allowEmpty: true });
	return fetch(ROUTER_SPEECH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(billTo ? { "X-HF-Bill-To": billTo } : {}),
		},
		body: JSON.stringify({
			input: clip.text,
			model: SPEECH_MODEL,
			voice,
			// A WAV of a full 1,200-character answer is about 5 MB, past Vercel's 4.5 MB response cap;
			// the MP3 is about a seventh of that.
			response_format: "mp3",
		}),
		signal,
	});
}
