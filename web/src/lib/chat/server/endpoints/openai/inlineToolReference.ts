// A model may write a tool call into the answer instead of `tool_calls` (CUR-2777). The stream carries a `{type: "reference", reference_ids: ["web_search"]}` part, then the call's arguments
// as ordinary text: `{"query": "…"}`. A citation's id is an integer; a tool's is its name. contentText
// writes a named reference as OPEN + name + CLOSE, and InlineToolReferenceStrip drops it together with
// the JSON object that follows, so the visitor never reads call arguments. It also writes the call as
// plain text, the declared tool's name then its arguments (`web_search{"query": …}`), so text that could
// still become `<tool name>{` is held back until it either does or cannot. The call itself is not run:
// the answer around it has already streamed, and continuing it after a search would write a second one.
// Each dropped call keeps its arguments, so a round whose only output was the call can still run it
// (CUR-4495, in openAIChatToTextGenerationStream).
//
// A gateway that drops the `reference` part (the staging router does) leaves only the bare arguments:
// `Santiago{"query": "capital of Chile"}`. So a JSON object outside a code span is held until it closes,
// and dropped when its keys fit a declared tool's parameters: every key one the tool declares, every key
// it requires present. Anything else is given back as it was.

import { logger } from "../../logger";

/** Private-use characters: no model writes them, and they never reach the visitor. */
export const TOOL_REF_OPEN = "";
export const TOOL_REF_CLOSE = "";

type Mode = "text" | "name" | "await" | "json" | "bare";

/** The part of a tool's JSON-schema parameters a bare call is matched against. */
export type InlineToolParameters = { properties?: Record<string, unknown>; required?: readonly string[] };

/** A declared tool: its name, and its parameters when the caller has them. */
export type InlineTool = string | { name: string; parameters?: InlineToolParameters };

/** Longest bare object held while it might be a call; past this it is given back as text. */
const BARE_HOLD_MAX = 2000;

/** Fed the answer's text chunk by chunk; returns what the visitor may see. */
export class InlineToolReferenceStrip {
	private mode: Mode = "text";
	private name = "";
	private held = "";
	private depth = 0;
	private inString = false;
	private escaped = false;
	/** The inline calls this stream dropped, in order, with their arguments as written. */
	readonly dropped: { name: string; arguments: string }[] = [];
	/** Text held in case it is the start of a declared tool's name followed by `{`. */
	private pending = "";
	private readonly calls: { name: string; opener: string }[];
	/** Declared tools with a parameter schema, which is what a bare object is matched against. */
	private readonly shapes: { name: string; keys: Set<string>; required: string[] }[];
	/** A run of backticks just written, and whether the text is inside a code span or fence. */
	private ticks = 0;
	private inInline = false;
	private inFence = false;

	/**
	 * @param tools the tools this request declared: a name typed straight before `{` is a call, and so is
	 * a bare object whose keys fit one's parameters.
	 */
	constructor(tools: readonly InlineTool[] = []) {
		const named = tools
			.map((t) => (typeof t === "string" ? { name: t } : t))
			.filter((t): t is Exclude<InlineTool, string> => Boolean(t.name));
		this.calls = named.map(({ name }) => ({ name, opener: `${name}{` }));
		this.shapes = named.flatMap((t) => {
			const keys = Object.keys(t.parameters?.properties ?? {});
			return keys.length ? [{ name: t.name, keys: new Set(keys), required: [...(t.parameters?.required ?? [])] }] : [];
		});
	}

	/** Notes backticks in text the visitor will see, so an object inside a code span is never held. */
	private seen(text: string): string {
		for (const ch of text) {
			if (ch === "`") {
				this.ticks++;
				continue;
			}
			this.closeTicks();
		}
		return text;
	}

	private closeTicks() {
		if (this.ticks >= 3) this.inFence = !this.inFence;
		else if (this.ticks > 0 && !this.inFence) this.inInline = !this.inInline;
		this.ticks = 0;
	}

	/** The declared tool a closed bare object is a call to, if its keys fit one. */
	private bareCall(text: string): string | undefined {
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return undefined;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const keys = Object.keys(value);
		if (!keys.length) return undefined;
		return this.shapes.find((s) => keys.every((k) => s.keys.has(k)) && s.required.every((r) => keys.includes(r)))
			?.name;
	}

	/** Moves held text out until what is left could still open a typed call. */
	private release(): string {
		let out = "";
		while (this.pending && !this.calls.some((c) => c.opener.startsWith(this.pending))) {
			out += this.pending[0];
			this.pending = this.pending.slice(1);
		}
		return out;
	}

	private openCall(name: string) {
		this.name = name;
		this.held = "{";
		this.mode = "json";
		this.depth = 1;
		this.inString = false;
		this.escaped = false;
	}

	push(chunk: string): string {
		let out = "";
		for (const ch of chunk) {
			switch (this.mode) {
				case "text": {
					if (ch === TOOL_REF_OPEN) {
						out += this.seen(this.pending);
						this.pending = "";
						this.mode = "name";
						this.name = "";
						break;
					}
					// A typed name before `{` is a call to that tool whatever its arguments, so it wins over a bare object.
					if (ch === "{" && this.shapes.length && !this.calls.some((c) => c.opener === this.pending + ch)) {
						if (this.ticks) this.closeTicks();
						if (!this.inInline && !this.inFence) {
							out += this.seen(this.pending);
							this.pending = "";
							this.held = "{";
							this.openCall("");
							this.mode = "bare";
							break;
						}
					}
					if (!this.calls.length) {
						out += this.seen(ch);
						break;
					}
					this.pending += ch;
					const typed = this.calls.find((c) => c.opener === this.pending);
					if (typed) {
						this.pending = "";
						this.openCall(typed.name);
					} else out += this.seen(this.release());
					break;
				}
				case "name":
					if (ch === TOOL_REF_CLOSE) {
						this.mode = "await";
						this.held = "";
					} else this.name += ch;
					break;
				case "await":
					if (ch === "{") this.openCall(this.name);
					else if (/\s/.test(ch)) this.held += ch;
					else {
						// A named reference with no call after it: nothing to drop but the marker.
						out += this.seen(this.held + ch);
						this.held = "";
						this.mode = "text";
					}
					break;
				case "bare":
					this.held += ch;
					if (this.inString) {
						if (this.escaped) this.escaped = false;
						else if (ch === "\\") this.escaped = true;
						else if (ch === '"') this.inString = false;
					} else if (ch === '"') this.inString = true;
					else if (ch === "{") this.depth++;
					else if (ch === "}" && --this.depth === 0) {
						const tool = this.bareCall(this.held);
						if (tool) {
							this.dropped.push({ name: tool, arguments: this.held });
							logger.info({ tool, shape: "bare" }, "[stream] inline tool reference dropped");
						} else out += this.seen(this.held);
						this.held = "";
						this.mode = "text";
						break;
					}
					if (this.held.length > BARE_HOLD_MAX) {
						out += this.seen(this.held);
						this.held = "";
						this.mode = "text";
					}
					break;
				case "json":
					this.held += ch;
					if (this.inString) {
						if (this.escaped) this.escaped = false;
						else if (ch === "\\") this.escaped = true;
						else if (ch === '"') this.inString = false;
					} else if (ch === '"') this.inString = true;
					else if (ch === "{") this.depth++;
					else if (ch === "}" && --this.depth === 0) {
						this.dropped.push({ name: this.name, arguments: this.held });
						logger.info({ tool: this.name }, "[stream] inline tool reference dropped");
						this.held = "";
						this.mode = "text";
					}
					break;
			}
		}
		return out;
	}

	/**
	 * End of the answer: whitespace held after a bare reference, and an object that never closed, are
	 * given back; an unclosed call after a reference or a tool's name is not.
	 */
	flush(): string {
		const out = this.pending + (this.mode === "await" || this.mode === "bare" ? this.held : "");
		this.pending = "";
		if (this.mode === "json") {
			this.dropped.push({ name: this.name, arguments: this.held });
			logger.info({ tool: this.name, unclosed: true }, "[stream] inline tool reference dropped");
		}
		this.mode = "text";
		this.held = "";
		return out;
	}
}
