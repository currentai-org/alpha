// The link a person pastes with "summarise this" is the one URL a turn may fetch directly.
//
// Only a URL the person typed in THIS message qualifies — never one the model wrote, and never a link
// found inside a fetched page. That is the same rule vendor fetch tools use against exfiltration: a
// fetch the model can aim is a channel out of the conversation. One URL per message, which also bounds
// what a message can cost in scrape credits.
//
// The fetch itself runs on Firecrawl's machines, not ours, so a URL naming an internal address can't
// reach this deployment's network. These checks refuse such URLs anyway rather than hand them to a
// third party: a raw IP, localhost, an internal-looking host, embedded credentials, or a non-web port. (CUR-1897)

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/i;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"»]+$/;
const INTERNAL_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i;
const MAX_URL_LENGTH = 2048;

/** The first fetchable http(s) URL in the person's own message, normalised, or undefined. */
export function extractLinkedUrl(text: string): string | undefined {
	const match = URL_IN_TEXT.exec(text ?? "");
	if (!match) return undefined;
	const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
	if (candidate.length > MAX_URL_LENGTH) return undefined;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.username || url.password) return undefined;
	if (url.port && url.port !== "80" && url.port !== "443") return undefined;
	const host = url.hostname.toLowerCase();
	// IPv6 literals arrive bracketed; IPv4 in any dotted-decimal form, including a bare integer.
	if (host.startsWith("[") || /^\d+(\.\d+){0,3}$/.test(host)) return undefined;
	if (!host.includes(".") || INTERNAL_SUFFIX.test(host)) return undefined;
	return url.href;
}

/** What happened this turn to the link the person pasted, as far as the model needs to know. */
export type LinkedPageState =
	| { kind: "read"; n: number }
	| { kind: "unreadable" }
	| { kind: "search-off" };

// A note for the person's own turn about the link they pasted (CUR-2032). It goes in the user turn,
// not the system prompt, because a model can under-weight the system role: with the page sitting in
// the system prompt as source [1], a model that has already said "I can't open links" in this
// conversation says it again and asks for the text to be pasted, even with the page read and
// grounded ("I don't have the survey content"). So the note names the
// source and retires the earlier refusal explicitly. The other two states replace a claim the model
// otherwise makes on its own, that it can never open links, which is false here and is what the next
// turn anchors on.
export function linkedPageNote(state: LinkedPageState): string {
	switch (state.kind) {
		case "read":
			return `The link in this message was opened for you on this turn, and the page's text is source [${state.n}] in the retrieved sources. Answer from that text and cite it. If an earlier reply in this conversation said you could not open links or asked for the text to be pasted, that no longer applies: do not repeat it.`;
		case "unreadable":
			return "This turn tried to open the link in this message and could not read the page; the site may block automated readers or need a login. Say that plainly and suggest pasting the text. Do not say you can never open links.";
		case "search-off":
			return 'Web search is off for this turn, so the link in this message was not opened. Say that plainly and tell the person they can switch the "Web search" control beside the message box to auto, or paste the text. Do not say you can never open links.';
	}
}
