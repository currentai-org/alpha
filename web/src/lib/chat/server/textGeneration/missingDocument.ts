// A task that points at a document nobody gave ("Can you summarise this agenda in three bullet points
// for our board?", "Translate the letter below into French.") comes back as an invented agenda or
// letter in most turns (4 of 5 each), and persona examples do not move that beyond noise. Whether a
// document is present is something the server already knows for certain: the turn's files, and the
// text of every message in the conversation. A verified-context note stating that fact still lost to
// the model in 7 of 20 turns, so a turn this detector matches is answered here and never reaches the
// model (CUR-1835).
//
// The detector is deliberately narrow, and every guard fails toward letting the model answer:
// - the last user message is short, on one line, and quotes nothing and has nothing after a colon,
//   so any pasted text keeps the turn out;
// - it pairs a task verb with a document reference ("this agenda", "the attached", "the letter
//   below");
// - no message in the conversation carries a file, and no earlier user turn is long enough to have
//   been the document.
// `web/evals/inspect_tasks/missing_document.py` measures the effect; its false-trigger rate on ordinary
// turns is recorded on CUR-1835.

import type { Message } from "$lib/chat/types/Message";

const MAX_TURN_CHARS = 200;
const MAX_EARLIER_USER_CHARS = 300;

const NOUN =
	"(?:agenda|document|doc|report|letter|file|attachment|e-?mail|essay|article|pdf|spreadsheet|minutes|transcript|contract|memo|notes|schedule|draft|passage|paragraph|cv|r[eé]sum[eé]|slides|presentation|brochure|proposal|policy|invoice|story|poem|text)";

// "this agenda", "the attached report", "my uploaded file", "the following letter", "these notes".
const DEICTIC_NOUN = new RegExp(
	String.raw`\b(?:this|these|the\s+(?:attached|enclosed|uploaded|following|above|below)|my\s+(?:attached|uploaded))\s+(?:\w+\s+)?${NOUN}s?\b`,
	"i"
);
// "the letter below", "the report I attached", "the file I just sent".
const NOUN_POINTER = new RegExp(
	String.raw`\b${NOUN}s?\s+(?:below|above|attached|enclosed|(?:that\s+)?I(?:'ve|\s+have)?\s+(?:just\s+)?(?:sent|shared|uploaded|pasted|attached))\b`,
	"i"
);
// "summarise the attached", "translate the following".
const BARE_POINTER = /\bthe\s+(?:attached|enclosed|following)\s*[?.!]?\s*$/i;

const TASK =
	/\b(?:summari[sz]e|summary|tl;?dr|translate|proofread|rewrite|re-?word|edit|review|check|shorten|condense|simplify|extract|pull|list|outline|explain|analy[sz]e|turn|convert|format|read|go\s+through|key\s+points|main\s+points|bullet|what\s+(?:are|is|does)|tell\s+me|give\s+me|fix|improve|critique|feedback)\b/i;

/** The document noun `text` asks for work on without containing it, or null. */
function absentDocumentNoun(text: string): string | null {
	const t = text.trim();
	if (!t || t.length > MAX_TURN_CHARS || t.includes("\n")) return null;
	// Anything after a colon, or anything quoted, may be the document itself.
	if (/:\s*\S/.test(t) || /["“”«»]/.test(t)) return null;
	if (!TASK.test(t)) return null;
	const named = DEICTIC_NOUN.exec(t) ?? NOUN_POINTER.exec(t);
	if (named) return displayNoun(new RegExp(NOUN, "i").exec(named[0])?.[0] ?? "document");
	return BARE_POINTER.test(t) ? "document" : null;
}

function displayNoun(noun: string): string {
	const n = noun.toLowerCase();
	if (n === "doc" || n === "attachment" || n === "file") return "document";
	if (n === "pdf" || n === "cv") return n.toUpperCase();
	if (n === "e-mail") return "email";
	return n;
}

/**
 * The reply for a turn that asks for work on a document the conversation does not contain, or
 * null to let the model answer. Null whenever any message carries a file or an earlier user turn is
 * long enough to have been the document, so a real document is never talked over.
 */
export function missingDocumentReply(messages: Pick<Message, "from" | "content" | "files">[]): string | null {
	if (messages.some((m) => (m.files?.length ?? 0) > 0)) return null;
	const users = messages.filter((m) => m.from === "user");
	const last = users.at(-1);
	if (!last) return null;
	const noun = absentDocumentNoun(last.content ?? "");
	if (!noun) return null;
	if (users.slice(0, -1).some((m) => (m.content ?? "").trim().length > MAX_EARLIER_USER_CHARS)) return null;
	return `I can't see the ${noun}: nothing was attached or pasted in this conversation. Paste its text into a message and I'll work from that.`;
}
