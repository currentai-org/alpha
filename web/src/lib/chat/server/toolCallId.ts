const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A tool call id in the only shape Mistral accepts: 9 of [a-zA-Z0-9]. With no argument the id is
 *  random. With a sequence number it is deterministic and unique per number, so a replayed transcript keeps
 *  byte-identical ids and the provider's prompt-prefix cache still hits. */
export function toolCallId(seq?: number): string {
	if (seq === undefined) return Array.from({ length: 9 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
	return `call${String(seq).padStart(5, "0")}`;
}
