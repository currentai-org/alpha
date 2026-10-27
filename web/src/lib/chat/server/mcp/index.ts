// Read-aloud orchestration — the entry point the chat flow calls on a turn that speaks.
//
//   maybeRunMcpTool(userMessage, { synthesizeText }):
//     seals a Kokoro clip of the text in its language (readAloudSpeech.ts), or skips with the reason.
//
// No Space is connected here (CUR-3989 retired the read-aloud Space); configured MCP servers run through
// serversKit.ts. FAIL-OPEN: any failure resolves to a skip or null, never a thrown error.
import type { ObjectId } from "bson";
import { logger } from "$lib/chat/server/logger";
import { stripThink } from "$lib/chat/server/stripThink";
import { readAloudVoice, voiceAccent } from "./readAloudLanguage";
import { SPEECH_COMPONENT, SPEECH_TOOL, speakableText, speechClipUrl } from "./readAloudSpeech";

export type McpToolResult = {
	tool: string;
	args: Record<string, unknown>;
	result: string;
	/** Origin of the Space that ran (e.g. https://resembleai-….hf.space) — for an honest "see the
	 *  component" link in the provenance trace. */
	space: string;
	/** Read-aloud: the accent the voice speaks, when the language has regional variants and the voice is
	 *  one of them ("Brazilian Portuguese", CUR-3989). Shown under the player. */
	voice?: string;
};

/** A tool was ATTEMPTED but abandoned because the open Space didn't respond in time (cold start) or
 *  errored. Distinct from `null` (no tool was needed / MCP off): the caller surfaces this so the skip
 *  is visible to the user, not silent. `ms` = how long we waited. */
export type McpSkipped = {
	skipped: true;
	ms: number;
	/** read-aloud has no voice for the answer's language; the language's English name. (CUR-3151) */
	unsupportedLanguage?: string;
	/** With `unsupportedLanguage`: a clip of the same text in the English voice, played only when the
	 *  visitor asks for it (CUR-3989). Nothing is synthesized until it is fetched. */
	fallbackAudio?: string;
};

/** The tool ran and reported an error (`isError`, CUR-2645). A skip in every place that only asks
 *  "did a tool produce something?", so nothing grounds on it, with the tool's own reason kept so the
 *  answer can say what went wrong. */
export type McpToolFailed = McpSkipped & { failed: true; tool: string; message: string };

/** Narrow a maybeRunMcpTool result to a tool that ran and reported an error. */
export function isMcpFailure(x: unknown): x is McpToolFailed {
	return x != null && typeof x === "object" && "failed" in x && x.failed === true;
}

/** A 2026-era server needs more input before this tool call can finish (CUR-1017). Parked in
 *  `mcp_elicitations`; the caller decides how (or whether) to surface it — v1 has no UI for this
 *  yet, since nothing live triggers it (the one configured Space is TTS-only). */
export type McpElicitationPending = { pending: true; elicitationId: string };

/** Narrow a maybeRunMcpTool result to a real tool run (vs a skip, a parked elicitation, or no-tool null). */
export function isMcpResult(
	x: McpToolResult | McpSkipped | McpToolFailed | McpElicitationPending | null
): x is McpToolResult {
	return x != null && "result" in x;
}

/** Path of the clip served under the `tts_canned_clip` fault (CUR-2253), from web/static. */
export const CANNED_READ_ALOUD_CLIP = "/e2e/canned-read-aloud.wav";

/** Willingness framing for a read-aloud turn, so the model's generation
 *  is a clean safety verdict that runs in PARALLEL with the TTS (it needs no tool result). Two jobs: kill
 *  the *capability* refusal ("I'm text-based, I can't read aloud" — a false decline that has nothing to do
 *  with safety, since a separate component does the speaking), and ask for a genuine appropriateness call.
 *  The model's answer is discarded on compliance (the body is the transcript) and shown on a decline. */
export function injectReadAloudJudgment(preprompt: string): string {
	return (
		`${preprompt}\n\n` +
		`The user asked to have text read aloud. A separate open text-to-speech component synthesizes and ` +
		`plays the audio — you do NOT produce audio yourself, so never say you are unable to speak, read ` +
		`aloud, or play sound. In ONE short sentence, confirm it's being read aloud. ONLY if reading this ` +
		`specific text aloud would be genuinely harmful or against policy, decline plainly instead. Do not ` +
		`restate these instructions.`
	);
}

// Media URLs an MCP Space returns (TTS → .wav, image gen → .png, etc.). Matches http(s) URLs whose
// path ends in a known media extension. Used to surface the asset deterministically when the model
// drops it from its answer (see textGeneration) — the inline renderer turns the link into a player.
const MEDIA_URL_RE =
	/(?:https?:\/\/[^\s'"<>)]+|\/chat\/api\/speech\/[\w.-]+)\.(?:mp3|wav|m4a|aac|flac|mp4|webm|mov|m4v|png|jpe?g|gif|webp|avif|svg)(?:[?#][^\s'"<>)]*)?/gi;

/** Distinct media URLs found in an MCP tool result (e.g. the .wav a TTS Space returns). */
export function extractMediaUrls(text: string): string[] {
	if (!text) return [];
	return [...new Set(Array.from(text.matchAll(MEDIA_URL_RE), (m) => m[0]))];
}

/** Remove specific media URLs (and the bracket/paren wrappers left around them) that the model emitted
 *  despite being told not to — markdown link `[label](url)` collapses to `label`; a bare `[url]`, `(url)`,
 *  `<url>` or raw `url` is dropped — so the deterministic player append is the ONLY surfacing of the media
 *  (no raw links, no duplicates). Then tidy the empty brackets / stray spaces / "…audio:" tails left behind.
 *  @internal exported for its unit tests */
export function stripMediaUrls(text: string, urls: string[]): string {
	if (!text || !urls.length) return text;
	let out = text;
	for (const u of urls) {
		const esc = u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out
			.replace(new RegExp(`\\[([^\\]]*)\\]\\(${esc}\\)`, "g"), "$1") // [label](url) → label
			// [url] (url) <url> url → "" — bracket immediately adjacent to the url only; DON'T consume the
			// surrounding spaces (that would fuse the neighbouring words, "one <url> two" → "onetwo").
			.replace(new RegExp(`[[(<]?${esc}[\\])>]?`, "g"), "");
	}
	return out
		.replace(/\[\s*\]|\(\s*\)|<\s*>/g, "") // empty wrappers left behind
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+([.,;:!?])/g, "$1") // space before punctuation
		.replace(/[:\-–—]\s*$/gm, "") // dangling "…audio:" / "…here is —" tails
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// Ephemeral Space/Gradio file URLs (`…hf.space/…/…audio.wav`) are tool artifacts that must NEVER appear as
// raw text in an answer: not when freshly generated (we attach a player instead) and not when the model
// echoes a STALE one from earlier in the conversation (no tool ran this turn — provenance "from training").
const SPACE_MEDIA_URL_RE =
	/https?:\/\/[^\s'"<>)]*\.hf\.space\/[^\s'"<>)]+\.(?:mp3|wav|m4a|aac|flac|mp4|webm|mov|m4v|png|jpe?g|gif|webp|avif|svg)(?:[?#][^\s'"<>)]*)?/gi;

/** Remove every ephemeral Space media URL from the text (and the bracket/paren wrappers around it), so a
 *  raw Gradio file URL can't leak into a chat bubble — whether the model just produced it or repeated an
 *  old one from history. Deterministic: we never rely on the model to format or omit the URL. */
export function stripSpaceMediaUrls(text: string): string {
	if (!text) return text;
	const urls = [...new Set(Array.from(text.matchAll(SPACE_MEDIA_URL_RE), (m) => m[0]))];
	return urls.length ? stripMediaUrls(text, urls) : text;
}

const AUDIO_EXT_RE = /\.(?:mp3|wav|m4a|aac|flac)(?:[?#]|$)/i;
/** Whether a URL points at an audio asset (a TTS Space's clip). */
export function isAudioUrl(url: string): boolean {
	return AUDIO_EXT_RE.test(url);
}

// Inline numbered citation markers — `[3]`, an adjacent run `[3][4][5]`, or `[3, 4]`. NOT a markdown
// link `[label](url)` (that's text, not a bare digit bracket, and is followed by `(`). These read aloud
// literally as "bracket three" through the TTS Space, which is confusing for a listener relying on voice.
// The on-screen text keeps its clickable citations; only the spoken copy is stripped.
const SPEECH_CITATION_RE = /\[\d+(?:\s*,\s*\d+)*\](?!\()/g;

/** Strip inline numbered citation markers from text destined for TTS, then tidy the whitespace and any
 *  space left dangling before punctuation. Speech-only: never applied to the rendered answer.
 *  @internal exported for its unit tests */
export function stripCitationsForSpeech(text: string): string {
	if (!text) return text;
	return text
		.replace(SPEECH_CITATION_RE, "")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+([.,;:!?])/g, "$1")
		.trim();
}

/** Count inline citation markers in text — a privacy-preserving metric (a number, never the content) so
 *  logs/observability can report how often the read-aloud guard fired without recording what was spoken. */
export function countSpeechCitations(text: string): number {
	return text ? (text.match(SPEECH_CITATION_RE) || []).length : 0;
}

/** Cap text before sending it to a TTS Space, so a long "speak every answer" response doesn't choke or
 *  hang the Space. Strips inline citation markers first (so they're neither spoken nor counted toward the
 *  cap), then trims to the last sentence end within the cap (else the last word) so it never cuts
 *  mid-word; appends an ellipsis when it had to truncate so the listener knows it's partial. */
export function capForSpeech(text: string, max = 1200): string {
	// Agent turns wrap their step narration in a literal <think>…</think> block that survives into
	// finalAnswer — the client hides it from the rendered markdown, but nothing server-side strips it
	// for the model-config-driven reasoning models (generate.ts's begin/endToken strip only fires when
	// the model declares a `reasoning` config, which the agent model deliberately doesn't, since its
	// think-block is a client rendering device, not model reasoning tokens). Left unstripped, the TTS
	// Space reads the opening tag as the bare word "think" before the real answer.
	text = stripThink(text);
	text = stripCitationsForSpeech(text);
	if (text.length <= max) return text;
	const slice = text.slice(0, max);
	const sentenceEnd = Math.max(
		slice.lastIndexOf(". "),
		slice.lastIndexOf("! "),
		slice.lastIndexOf("? "),
		slice.lastIndexOf("\n")
	);
	if (sentenceEnd > max * 0.5) return slice.slice(0, sentenceEnd + 1).trim();
	const lastSpace = slice.lastIndexOf(" ");
	return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim() + "…";
}

/** The primary text the user asked an open component to act on — a TTS Space's spoken text (its
 *  `text_input`), an image Space's prompt. Tool arg shapes vary by Space, so prefer a text-ish key and
 *  otherwise take the longest string value (the synthesized text is reliably longer than knobs like a
 *  language code or step count). Used to show the VERBATIM transcript as a read-aloud turn's message body
 *  instead of the model's filler prose — deterministic, straight from the tool call. */
export function extractToolInputText(args: Record<string, unknown>): string | undefined {
	const strs = Object.entries(args)
		.map(([k, v]) => ({ k, v: typeof v === "string" ? v.trim() : "" }))
		.filter(({ v }) => v.length > 0);
	if (!strs.length) return undefined;
	const textish = strs.filter(({ k }) =>
		/text|prompt|input|content|message|sentence|speech/i.test(k)
	);
	const pool = textish.length ? textish : strs;
	return pool.reduce((a, b) => (b.v.length > a.v.length ? b : a)).v;
}

// "read/repeat that aloud" with NO inline text of its own → the user means the PREVIOUS answer. The
// router only sees this bare command, so without substituting the prior answer it would try to synthesize
// the word "that". ANCHORED ^…$ so the WHOLE message must be the read-aloud command (modulo a polite
// wrapper + trailing punctuation): an unanchored match fires on any turn that merely CONTAINS
// "say"/"speak"/"play"/"it"/"this"/"answer" (e.g. "can you speak to how this works?"), which makes auto-read
// synthesize the PRIOR answer over the current one, so the voice no longer matches the text. Two
// branches: strong read-verbs (read/repeat/narrate/play) + a back-reference to the prior turn, OR
// read/say/speak + an explicit "aloud"/"out loud". A colon, a long quoted span, or a long message means the
// text is inline / it's a real query, so this returns false and the normal extraction path runs.
const READ_PRIOR_RE =
	/^\s*(?:(?:hey|ok|okay|so)\s+)?(?:(?:can|could|would|will|do)\s+you\s+)?(?:please\s+|pls\s+|kindly\s+|just\s+|now\s+)*(?:(?:read|repeat|narrate)\b[^?.!]*\b(?:that|this|it|again|back|previous|last|above|response|answer)\b|(?:read|say|speak|play)\b[^?.!]*\b(?:aloud|out\s+loud)\b)[^?.!]*[?.!]*\s*$/i;
export function isReadPriorAloud(text: string): boolean {
	const t = (text ?? "").trim();
	if (!t || t.includes(":")) return false;
	if (t.length > 120) return false; // a bare read-aloud command is short; a long message is a real query
	if (/["“][^"”]{8,}["”]/.test(t)) return false; // an inline quoted payload — read that, not the prior turn
	return READ_PRIOR_RE.test(t);
}

// Whether the model's answer LEADS with a refusal ("I'm sorry, but I can't…", "I cannot…", "Unfortunately
// I'm unable…"). Used to honor a MODEL decline on a read-aloud turn: the open component's audio is HELD and
// surfaced only if the model didn't also decline. Deliberately conservative — keys on the lead, where
// refusals state themselves — and safety-conservative in its error direction: a false "declined" just shows
// the model's own words instead of playing audio (cheap); a false "complied" would surface a clip the model
// objected to (the costly miss we avoid). NOT a general safety oracle; the pre-screen (Coop) is that.
const MODEL_DECLINE_RE =
	/^[\s"'“]*(i'?m\s+sorry|i\s+apologi[sz]e|unfortunately,?\s+i|i'?m\s+afraid|i\s+(?:can'?t|cannot|won'?t|will\s+not|am\s+unable|am\s+not\s+able|must\s+(?:respectfully\s+)?decline|don'?t\s+feel\s+comfortable|am\s+not\s+comfortable|do\s+not\s+feel\s+comfortable))\b/i;
export function isModelDecline(text: string): boolean {
	return !!text && MODEL_DECLINE_RE.test(text.trim());
}

/** The read-aloud clip for `opts.synthesizeText`, or a skip saying why there is none; null when the
 *  turn has no text to speak or may not speak (`allowTts` false, speak = off). Never throws. */
export async function maybeRunMcpTool(
	userMessage: string,
	opts?: {
		synthesizeText?: string;
		allowTts?: boolean;
		/** The clip is sealed to its conversation, so the speech route plays it only to its owner. */
		conversationId?: ObjectId;
		/** Set only under the `tts_canned_clip` fault (preview/development plus the e2e (CUR-2253)
		 *  secret). A TTS-eligible call answers with this clip instead of synthesizing one. */
		cannedClipUrl?: string;
		/** Set only under `tts_slow_canned_clip`. The canned clip arrives after this long. (CUR-3810) */
		cannedClipDelayMs?: number;
		/** Set only under the `tts_space_down` fault. A TTS-eligible call skips as if the (CUR-2268)
		 *  Space had timed out, so a spec can read the note a visitor gets when read-aloud fails. */
		spaceDown?: boolean;
		/** The visitor's browser language (ISO 639-1), the voice for an answer with too few letters to
		 *  detect when the question doesn't settle it. */
		fallbackLanguage?: string;
	}
): Promise<McpToolResult | McpSkipped | McpToolFailed | McpElicitationPending | null> {
	// Default true so existing callers that omit it keep today's behavior; textGeneration passes
	// allowTts=false when the effective speak mode is "off".
	const allowTts = opts?.allowTts !== false;

	if (opts?.spaceDown && allowTts) {
		logger.info({ decided: "tts", reason: "tts_space_down" }, "[mcp] simulated Space timeout");
		return { skipped: true, ms: 0 };
	}
	// Gated on allowTts, so a turn that may not speak never gets audio from the canned clip either.
	if (opts?.cannedClipUrl && allowTts) {
		logger.info({ decided: "tts", reason: "tts_canned_clip" }, "[mcp] canned clip, Space not called");
		if (opts.cannedClipDelayMs) await new Promise((r) => setTimeout(r, opts.cannedClipDelayMs));
		return {
			tool: "e2e_canned_tts",
			args: { text: opts.synthesizeText ?? userMessage },
			result: opts.cannedClipUrl,
			space: "e2e canned clip",
		};
	}
	// The clip is Kokoro through Hugging Face's router (readAloudSpeech.ts), in the answer's
	// language or not at all. (CUR-3151)
	if (opts?.synthesizeText && allowTts) return readAloudClip(opts.synthesizeText, opts.conversationId, userMessage, opts.fallbackLanguage);
	return null;
}

/** The read-aloud clip for `text`: a URL the player fetches, or a skip naming the language when
 *  Kokoro has no voice for it (CUR-3151, CUR-3989). `question` is the person's message, which settles the
 *  language of a one-line answer. */
async function readAloudClip(
	answer: string,
	conversationId: ObjectId | undefined,
	question: string,
	fallbackLanguage?: string
): Promise<McpToolResult | McpSkipped | McpToolFailed> {
	const t0 = Date.now();
	if (!conversationId) {
		// The speech route serves a clip only to its conversation's owner, so a clip with no conversation
		// could never play.
		logger.error({ decided: "tts" }, "[mcp] read-aloud skipped: no conversation to bind the clip to");
		return { skipped: true, ms: Date.now() - t0, failed: true, tool: SPEECH_TOOL, message: "Read aloud is not available here" };
	}
	// The visitor sees `shown` as the transcript (the turn reads `args.text`), so it keeps its
	// Markdown; only the clip gets the speakable words.
	const shown = stripCitationsForSpeech(answer);
	const text = speakableText(shown);
	if (!text) {
		logger.info({ decided: "tts", reason: "nothing-speakable" }, "[mcp] read-aloud skipped: no words to read");
		return { skipped: true, ms: Date.now() - t0 };
	}
	const voice = await readAloudVoice(text, question, fallbackLanguage);
	if (!voice.ok) {
		logger.info(
			{ decided: "tts", reason: "no-voice-for-language", language: voice.tag },
			"[mcp] read-aloud skipped: no voice for this language"
		);
		return {
			skipped: true,
			ms: Date.now() - t0,
			unsupportedLanguage: voice.name,
			...englishFallbackClip(text, conversationId)
		};
	}
	try {
		const clip = speechClipUrl({ text, language: voice.code, conversation: conversationId.toString() });
		const accent = voiceAccent(voice.code);
		logger.info(
			{ decided: "tts", language: voice.code, inputChars: text.length, citationsStripped: countSpeechCitations(answer) },
			"[mcp] read-aloud clip ready"
		);
		return {
			tool: SPEECH_TOOL,
			args: { text: shown },
			result: clip,
			space: SPEECH_COMPONENT,
			...(accent ? { voice: accent } : {})
		};
	} catch (e) {
		logger.error({ err: e }, "[mcp] read-aloud clip could not be sealed");
		return { skipped: true, ms: Date.now() - t0, failed: true, tool: SPEECH_TOOL, message: "Read aloud is not configured" };
	}
}

/** The English-voice clip a visitor may ask for when the answer's language has no voice. A sealing
 *  failure leaves the offer out; the note still says there is no voice. */
function englishFallbackClip(text: string, conversationId: ObjectId): { fallbackAudio?: string } {
	try {
		return { fallbackAudio: speechClipUrl({ text, language: "en", conversation: conversationId.toString() }) };
	} catch (e) {
		logger.error({ err: e }, "[mcp] read-aloud English fallback clip could not be sealed");
		return {};
	}
}
