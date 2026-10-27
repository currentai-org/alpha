import { writeClipboard } from "$lib/chat/utils/writeClipboard";

export type CopyState = "idle" | "copied" | "failed";

/**
 * A copy control's feedback: "copied" or "failed" after each copy, back to idle after a delay.
 * One reset timer, cleared by the next copy, so an earlier copy's timer can't cut a later
 * one short. CUR-2823: a refused copy reads "failed" instead of looking like nothing happened. (CUR-2920)
 */
export class CopyFeedback {
	state = $state<CopyState>("idle");
	#timer: ReturnType<typeof setTimeout> | undefined;
	#copiedMs: number;
	#failedMs: number;

	constructor(copiedMs: number, failedMs = 3000) {
		this.#copiedMs = copiedMs;
		this.#failedMs = failedMs;
	}

	/** Copies `text` and returns whether it landed. */
	async copy(text: string): Promise<boolean> {
		const copied = await writeClipboard(text);
		this.state = copied ? "copied" : "failed";
		clearTimeout(this.#timer);
		this.#timer = setTimeout(
			() => {
				this.state = "idle";
			},
			copied ? this.#copiedMs : this.#failedMs
		);
		return copied;
	}

	dispose() {
		clearTimeout(this.#timer);
	}
}
