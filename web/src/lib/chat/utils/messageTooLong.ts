const count = new Intl.NumberFormat("en");

/**
 * The refusal for a message over `USAGE_LIMITS.messageLength`, worded so the person knows how much to cut
 * and that their text was kept (CUR-3695). The composer, the edit box and parseRequest all say this, so a
 * refusal reads the same wherever it is caught. It sits in a two-line toast, so it stays near 100 characters.
 */
export function messageTooLongMessage(length: number, limit: number): string {
	return `Message too long: ${count.format(length)} characters, the limit is ${count.format(limit)}. Cut ${count.format(length - limit)} to send it; your text is still here.`;
}
