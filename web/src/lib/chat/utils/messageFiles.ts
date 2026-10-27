import file2base64 from "$lib/chat/utils/file2base64";
import type { MessageFile } from "$lib/chat/types/Message";

// One encode per attached File. A send from a new chat encodes on the landing page so its stand-in
// bubble shows the files, and the conversation page then reuses the same encodes, so neither bubble
// is ever on screen without its files (CUR-3402) and the handover has no encode to wait on (CUR-3506).
const encodes = new WeakMap<File, Promise<MessageFile>>();

function encodeOne(file: File): Promise<MessageFile> {
	let encoded = encodes.get(file);
	if (!encoded) {
		encoded = file2base64(file).then((value) => ({
			type: "base64" as const,
			value,
			mime: file.type,
			name: file.name,
		}));
		// A failed read is not remembered, so the next send tries the file again.
		encoded.catch(() => encodes.delete(file));
		encodes.set(file, encoded);
	}
	return encoded;
}

/** The files as a message carries them, encoding each File at most once. */
export function encodeMessageFiles(files: File[]): Promise<MessageFile[]> {
	return Promise.all(files.map(encodeOne));
}
